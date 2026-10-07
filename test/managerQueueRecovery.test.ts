import { afterAll, afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../lib/acp/manager";
import { METHODS } from "../lib/acp/types";
import { readAllQueues } from "../lib/promptQueue";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";
import { itemLogResetForTests } from "../lib/itemLog";

/* eslint-disable @typescript-eslint/no-explicit-any */

const fixtureDirs = [process.env.DEVIN_WEB_STATE_DIR!, process.env.DEVIN_CLI_DIR!, dirname(process.env.DEVIN_WEB_DEVIN_CONFIG!)];
const managers: SessionManager[] = [];
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
afterAll(() => {
  for (const manager of managers) (manager as any).dbSub?.();
  itemLogResetForTests();
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  vi.useFakeTimers();
  const manager = new SessionManager();
  managers.push(manager);
  const m = manager as any;
  m.ensure = async () => ({}); // Never start a real agent.
  const s = { sessionId: "retry", cwd: "/tmp", running: false, loaded: true, attachedGen: m.generation, queue: [] as any[] };
  m.sessions.set(s.sessionId, s);
  const sent: string[] = [];
  m.bridge.request = async (method: string, params: any) => {
    if (method === METHODS.sessionPrompt) sent.push(params.prompt[0].text);
    return {};
  };
  const original = m.regions.beginTurn.bind(m.regions);
  let blocked = true;
  const begin = vi.spyOn(m.regions, "beginTurn").mockImplementation((sid) => blocked ? undefined : original(sid));
  return { manager, m, s, sent, begin, recover: () => { blocked = false; } };
}

it("retries storage recovery without browser traffic and drains each persisted prompt once", async () => {
  const { manager, s, sent, begin, recover } = fixture();
  await manager.prompt(s.sessionId, [{ type: "text", text: "A" }]);
  await manager.prompt(s.sessionId, [{ type: "text", text: "B" }]);
  const ids = manager.queueState(s.sessionId).queue.map((q) => q.id);
  await vi.advanceTimersByTimeAsync(999);
  expect(begin).toHaveBeenCalledTimes(1);
  expect(sent).toEqual([]);
  recover();
  await vi.advanceTimersByTimeAsync(1001);
  expect(sent).toEqual(["A", "B"]);
  expect(manager.queueState(s.sessionId)).toMatchObject({ running: false, queued: 0 });
  expect(readAllQueues()[s.sessionId] ?? []).toEqual([]);
  expect(new Set(ids).size).toBe(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sent).toEqual(["A", "B"]);
});

it.each([false, true])("backs off repeated start failures without losing queued identities (throw: %s)", async (throws) => {
  const { manager, s, sent, begin, recover } = fixture();
  if (throws) begin.mockImplementation(() => { throw new Error("persistent start error"); });
  await manager.prompt(s.sessionId, [{ type: "text", text: "A" }]);
  const id = manager.queueState(s.sessionId).queue[0].id;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(begin.mock.calls.length).toBeGreaterThan(1);
  expect(begin.mock.calls.length).toBeLessThanOrEqual(10);
  expect(sent).toEqual([]);
  expect(readAllQueues()[s.sessionId].map((q) => q.id)).toEqual([id]);
  const items = (manager as any).view.meta(s.sessionId).items ?? [];
  expect(items.filter((item: any) => item.kind === "notice" && /new session/i.test(item.text))).toHaveLength(1);
  if (throws) begin.mockRestore();
  recover();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(sent).toEqual(["A"]);
});

it("resumes SQLite finalization and the queued prompt automatically after storage recovers", async () => {
  const { manager, m, s, sent, begin } = fixture();
  begin.mockRestore();
  const { openDb } = await import("../lib/sqlite");
  const itemLog = await import("../lib/itemLog");
  itemLog.itemLogSave(s.sessionId, "old-turn", 100, [{
    id: "old-thought", kind: "text", role: "thought", text: "keep across restart",
    done: true, seqFrom: 40, seqTo: 41,
  }], true);
  itemLog.itemLogResetForTests();
  m.testDurable.set(s.sessionId, 110);
  const db = openDb(join(process.env.DEVIN_WEB_STATE_DIR!, "itemlog.db"));
  try {
    db.exec(`CREATE TRIGGER reject_auto_retry BEFORE INSERT ON items
      WHEN NEW.session_id = 'retry' AND NEW.done = 1
      BEGIN SELECT RAISE(ABORT, 'temporary disk failure'); END`);
    expect(await manager.prompt(s.sessionId, [{ type: "text", text: "next" }])).toEqual({ queued: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([]);
    expect(itemLog.itemLogRestore(s.sessionId)?.items).toContainEqual(expect.objectContaining({ text: "keep across restart" }));
    db.exec("DROP TRIGGER reject_auto_retry");
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual(["next"]);
    itemLog.itemLogResetForTests();
    expect(itemLog.itemLogLoadRetained(s.sessionId)).toContainEqual(expect.objectContaining({ text: "keep across restart" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual(["next"]);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS reject_auto_retry"); db.close();
    m.dbSub?.(); itemLog.itemLogForget(s.sessionId);
  }
});

it("suspends retry during deletion and resumes autonomously if deletion fails", async () => {
  const { manager, m, s, sent, begin, recover } = fixture();
  const originalRequest = m.bridge.request;
  let rejectDelete!: (reason: Error) => void;
  m.bridge.request = (method: string, params: any) => method === METHODS.sessionDelete
    ? new Promise((_resolve, reject) => { rejectDelete = reject; }) : originalRequest(method, params);
  await manager.prompt(s.sessionId, [{ type: "text", text: "A" }]);
  const deletion = manager.deleteSession(s.sessionId);
  const result = expect(deletion).rejects.toThrow("delete failed");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(sent).toEqual([]);
  expect(begin).toHaveBeenCalledTimes(1);
  rejectDelete(new Error("delete failed"));
  await result;
  recover();
  await vi.advanceTimersByTimeAsync(2000);
  expect(sent).toEqual(["A"]);
});

it("keeps an idle send-now failure at its original queue position", async () => {
  const { manager, s, sent, recover } = fixture();
  for (const text of ["A", "B", "C"]) await manager.prompt(s.sessionId, [{ type: "text", text }]);
  const ids = manager.queueState(s.sessionId).queue.map((q) => q.id);
  expect(manager.sendQueuedNow(s.sessionId, ids[1])).toEqual({ sent: false });
  expect(manager.queueState(s.sessionId).queue.map((q) => q.id)).toEqual(ids);
  expect(readAllQueues()[s.sessionId].map((q) => q.id)).toEqual(ids);
  recover();
  await vi.advanceTimersByTimeAsync(2000);
  expect(sent).toEqual(["A", "B", "C"]);
});

it.each(["cancel", "dequeue", "delete", "generation", "replacement"])("retires a pending retry after %s", async (action) => {
  const { manager, m, s, sent, begin, recover } = fixture();
  m.bridge.notify = () => {};
  await manager.prompt(s.sessionId, [{ type: "text", text: "A" }]);
  const id = manager.queueState(s.sessionId).queue[0].id;
  if (action === "cancel") manager.cancel(s.sessionId, { clearQueue: true });
  if (action === "dequeue") manager.dequeue(s.sessionId, id);
  if (action === "delete") await manager.deleteSession(s.sessionId);
  if (action === "generation") m.bridge.handlers.onExit(1, null);
  if (action === "replacement") m.sessions.set(s.sessionId, { ...s, queue: [] });
  recover();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sent).toEqual([]);
  expect(begin).toHaveBeenCalledTimes(1);
});
