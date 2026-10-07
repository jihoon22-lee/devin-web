import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewFrame, ViewPatch } from "../lib/acp/sessionView";
import type { AssembledItem } from "../lib/acp/itemAssembler";

const stateDir = mkdtempSync(join(tmpdir(), "session-view-state-"));
const cliDir = mkdtempSync(join(tmpdir(), "session-view-cli-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;
process.env.DEVIN_CLI_DIR = cliDir;
vi.mock("../lib/transcript-db", async (original) => ({
  ...await original<typeof import("../lib/transcript-db")>(),
  readTranscriptItems: vi.fn(() => ({ items: [], truncated: false })),
}));
const { SessionManager } = await import("../lib/acp/manager");
const { METHODS } = await import("../lib/acp/types");
const { itemLogLoadMeta, itemLogResetForTests } = await import("../lib/itemLog");
const { writeSessionQueue } = await import("../lib/promptQueue");
const { readTranscriptItems } = await import("../lib/transcript-db");
const managers: InstanceType<typeof SessionManager>[] = [];

function manager() {
  const m = new SessionManager();
  managers.push(m);
  return m;
}
function harness(sid: string) {
  const m = manager();
  // The same hermetic bridge/session seam used by manager.test.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mi = m as any;
  mi.ensure = async () => ({});
  let finish = () => {};
  mi.bridge.request = async (method: string) => {
    if (method === METHODS.sessionPrompt) return new Promise<void>((resolve) => { finish = resolve; });
    return {};
  };
  mi.sessions.set(sid, { sessionId: sid, cwd: "/tmp", running: false, loaded: true, attachedGen: mi.generation, queue: [] });
  const frames: ViewFrame[] = [];
  m.subscribeView(sid, (frame) => frames.push(frame));
  return { m, mi, frames, finish: async () => { finish(); await Promise.resolve(); } };
}
function patches(frames: ViewFrame[]): ViewPatch[] {
  return frames.filter((f): f is ViewPatch => f.t === "patch");
}
function applyRegion(items: AssembledItem[], patch: ViewPatch): AssembledItem[] {
  if (!patch.prov) return items;
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const i of patch.prov.upsert) byId.set(i.id, i);
  return patch.prov.order.map((id) => byId.get(id)!);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const m of managers.splice(0)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    mi.dbSub?.();
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => {
  itemLogResetForTests();
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(cliDir, { recursive: true, force: true });
});

describe("manager → view (D V1-3)", () => {
  it("observes metadata and replays the missed version tail", () => {
    const h = harness("meta");
    const base = h.m.view.version("meta");
    h.mi.emit("meta", "session_update", { sessionUpdate: "config_option_update", configOptions: [{ id: "model" }] });
    expect(h.frames.at(-1)).toMatchObject({ t: "patch", v: base + 1, meta: { configOptions: [{ id: "model" }] } });
    h.mi.emit("meta", "session_update", { sessionUpdate: "session_info_update", title: "B" });
    expect(h.m.viewSince("meta", base + 1)?.map((p) => p.v)).toEqual([base + 2]);
  });

  it("publishes flush and turn-flip regions through the db-change path", async () => {
    const h = harness("flip");
    h.m.__testDurableThrough("flip", 100);
    await h.m.prompt("flip", [{ type: "text", text: "go" }]);
    h.mi.emit("flip", "session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
    await vi.advanceTimersByTimeAsync(40);
    expect(patches(h.frames).filter((p) => p.prov).at(-1)?.prov?.order).toHaveLength(2);
    await h.finish();
    h.m.__testDurableThrough("flip", 110);
    const flip = patches(h.frames).at(-1);
    expect(flip).toMatchObject({ prov: { order: [] }, durableThrough: 110 });
    expect(flip?.retained?.map((i) => i.role)).toEqual(["thought"]);
  });

  it("snapshots current pre-flush items at their final version and continues from that baseline", async () => {
    const h = harness("current");
    await h.m.prompt("current", [{ type: "text", text: "go" }]);
    h.mi.emit("current", "session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first" } });
    const beforeSnapshot = h.m.view.version("current");
    const snap = h.m.viewSnapshot("current");
    expect(snap.v).toBeGreaterThan(beforeSnapshot);
    expect(h.m.viewSince("current", beforeSnapshot)!.reduce(applyRegion, [])).toEqual(snap.provisional);
    expect(snap.provisional.map((i) => i.text)).toContain("first");
    expect(snap.v).toBe(h.m.view.version("current"));
    expect(h.m.viewSince("current", snap.v)).toEqual([]);
    h.mi.emit("current", "session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " second" } });
    await vi.advanceTimersByTimeAsync(40);
    const applied = h.m.viewSince("current", snap.v)!.reduce(applyRegion, snap.provisional);
    expect(applied).toEqual(h.m.provisional("current"));
    expect(snap.provisional.map((i) => i.text)).toContain("first");
    await h.finish();
  });

  it("restores persisted metadata and provisional items with authoritative runtime state", async () => {
    const h = harness("restart");
    h.mi.emit("restart", "session_update", { sessionUpdate: "available_commands_update", availableCommands: [{ name: "rename" }] });
    h.m.__testDurableThrough("restart", 200);
    await h.m.prompt("restart", [{ type: "text", text: "go" }]);
    h.mi.emit("restart", "session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
    await vi.advanceTimersByTimeAsync(600);
    writeSessionQueue("restart", [{ id: "saved-q", blocks: [{ type: "text", text: "later" }] }]);
    itemLogResetForTests();
    const fresh = manager();
    const snap = fresh.viewSnapshot("restart");
    expect(snap.meta.commands).toEqual([{ name: "rename" }]);
    expect(snap.provisional.map((i) => i.text)).toContain("partial");
    expect(snap.durableThrough).toBe(200);
    expect(snap.meta).toMatchObject({ running: false, queued: 1, queueItems: [{ id: "saved-q", text: "later" }] });
    expect(snap.v).toBe(fresh.view.version("restart"));
    expect(fresh.viewSnapshot("restart").v).toBe(snap.v);
    await h.finish();
  });

  it("restores one answerable permission card when the same daemon replays across a web restart", async () => {
    const sid = "permission-restart";
    const h = harness(sid);
    await h.m.prompt(sid, [{ type: "text", text: "go" }]);
    const identity = { jsonrpc: "2.0", method: "_devin-web/request_identity", params: { rpcId: 731, method: METHODS.requestPermission, sessionId: sid, requestId: `req-${"a".repeat(32)}` } };
    const request = { jsonrpc: "2.0", id: 731, method: METHODS.requestPermission, params: { sessionId: sid, options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }] } };
    h.mi.bridge.dispatch(identity);
    h.mi.bridge.dispatch(request);
    const before = h.m.provisional(sid).find((item) => item.kind === "request")!;
    await vi.advanceTimersByTimeAsync(600);
    itemLogResetForTests();
    const fresh = harness(sid);
    fresh.mi.sessions.get(sid).running = true;
    fresh.mi.bridge.dispatch(identity);
    fresh.mi.bridge.dispatch(request);
    const cards = fresh.m.viewSnapshot(sid).provisional.filter((item) => item.kind === "request");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: before.id, requestId: before.requestId, resolved: false });
    expect(fresh.m.pendingFor(sid)).toHaveLength(1);
    expect(fresh.m.respondToRequest(before.requestId!, { outcome: { outcome: "selected", optionId: "once" } }, sid)).toBe(true);
    expect(fresh.m.provisional(sid).find((item) => item.kind === "request")).toMatchObject({ resolved: true, resolvedWith: "Allow once" });
    fresh.mi.bridge.dispatch({ ...identity, params: { ...identity.params, requestId: `req-${"b".repeat(32)}` } });
    fresh.mi.bridge.dispatch(request); // the agent legally reuses its settled RPC id
    expect(fresh.m.provisional(sid).filter((item) => item.kind === "request")).toHaveLength(2);
    expect(fresh.m.pendingFor(sid)).toHaveLength(1);
    await h.finish();
  });

  it("reconciles runtime requests and queue without resetting runningSince or publishing snapshot no-ops", async () => {
    const h = harness("runtime");
    await h.m.prompt("runtime", [{ type: "text", text: "go" }]);
    await h.m.prompt("runtime", [{ type: "text", text: "later" }]);
    const since = h.m.view.meta("runtime").runningSince;
    // A pending request can exist before the view entry is seeded (daemon adoption).
    h.mi.pendingRequests.set("pending", { requestId: "pending", sessionId: "runtime", method: "permission", params: { label: "allow" }, createdAt: 1 });
    const snap = h.m.viewSnapshot("runtime");
    expect(snap.meta.running).toBe(true);
    expect(snap.meta.runningSince).toBe(since);
    expect(snap.meta.queued).toBe(1);
    expect(snap.meta.items).toContainEqual(expect.objectContaining({ kind: "request", requestId: "pending", params: { label: "allow" } }));
    expect(h.m.viewSnapshot("runtime").v).toBe(snap.v);
    h.mi.pendingRequests.delete("pending");
    h.mi.sessions.get("runtime").queue = [];
    const next = h.m.viewSnapshot("runtime");
    expect(next.meta.queueItems ?? []).toEqual([]);
    expect(next.meta.items.some((i) => i.kind === "request" && i.requestId === "pending" && !i.resolved)).toBe(false);
    expect(h.m.viewSnapshot("runtime").v).toBe(next.v);
    await h.finish();
  });

  it("reads durable rows with exactly the snapshot watermark", () => {
    const m = manager();
    const through = vi.spyOn(m, "durableThrough").mockReturnValueOnce(42).mockReturnValue(99);
    const snap = m.viewSnapshot("watermark");
    expect(through).toHaveBeenCalledTimes(1);
    expect(readTranscriptItems).toHaveBeenLastCalledWith("watermark", { tail: 50, through: 42 });
    expect(snap.durableThrough).toBe(42);
  });

  it("does not publish hydration patches to a new subscriber before its initial snapshot", () => {
    const m = manager();
    const received: ViewFrame[] = [];
    m.subscribeView("initial", (f) => received.push(f));
    const snap = m.viewSnapshot("initial");
    expect(received).toEqual([]);
    expect(m.viewSnapshot("initial").v).toBe(snap.v);
  });

  it("delivers reentrant view publications FIFO even when the publishing subscriber throws", () => {
    const m = manager();
    const sid = "reentrant";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    m.subscribeView(sid, (frame) => {
      if (frame.meta?.title !== "outer") return;
      m.view.setMeta(sid, { title: "nested-one" });
      m.view.setMeta(sid, { title: "nested-two" });
      throw new Error("subscriber failed after publishing");
    });
    const frames: ViewFrame[] = [];
    m.subscribeView(sid, (frame) => frames.push(frame));
    const base = m.view.version(sid);
    m.view.setMeta(sid, { title: "outer" });
    m.view.setMeta(sid, { title: "later" });
    expect(frames).toEqual(["outer", "nested-one", "nested-two", "later"].map((title, i) => ({
      t: "patch", v: base + i + 1, meta: { title },
    })));
    expect(error).toHaveBeenCalledWith("[view] subscriber failed", expect.any(Error));
  });

  it("isolates throwing view subscribers without starving others or aborting metadata persistence", async () => {
    const h = harness("callbacks");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const unsubscribe = h.m.subscribeView("callbacks", () => { throw new Error("subscriber failed"); });
    const healthy = vi.fn();
    h.m.subscribeView("callbacks", healthy);
    expect(() => h.mi.emit("callbacks", "session_update", { sessionUpdate: "session_info_update", title: "saved" })).not.toThrow();
    expect(healthy).toHaveBeenCalledWith(expect.objectContaining({ meta: { title: "saved" } }));
    expect(error).toHaveBeenCalledWith("[view] subscriber failed", expect.any(Error));
    await h.m.prompt("callbacks", [{ type: "text", text: "go" }]);
    await h.finish();
    expect(h.m.getSession("callbacks")?.running).toBe(false);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(500);
    expect(itemLogLoadMeta("callbacks")?.title).toBe("saved");
  });

  it("forgets deletion state and cancels metadata persistence that could resurrect it", async () => {
    const h = harness("delete");
    h.mi.emit("delete", "session_update", { sessionUpdate: "session_info_update", title: "saved" });
    await vi.advanceTimersByTimeAsync(500);
    h.mi.emit("delete", "session_update", { sessionUpdate: "session_info_update", title: "pending" });
    await h.m.deleteSession("delete");
    expect(h.m.view.version("delete")).toBe(0);
    const reset = h.frames.at(-1)!;
    expect(reset).toMatchObject({ t: "snapshot", v: 0, meta: { running: false, queued: 0, items: [] },
      provisional: [], retained: [], durable: [], durableThrough: 0 });
    expect(h.m.viewSince("delete", 1)).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    expect(itemLogLoadMeta("delete")).toBeNull();
    expect(manager().viewSnapshot("delete").meta.title).toBeUndefined();
    // Simulate a connected consumer that resets its cursor on the snapshot.
    h.mi.emit("delete", "session_update", { sessionUpdate: "session_info_update", title: "new session" });
    const fresh = patches(h.frames).at(-1)!;
    expect(fresh.v).toBeGreaterThan(reset.v);
    expect(fresh.meta?.title).toBe("new session");
  });

  it("keeps the view and subscriber cursor intact when deletion fails", async () => {
    const h = harness("refused-delete");
    h.mi.emit("refused-delete", "session_update", { sessionUpdate: "session_info_update", title: "keep" });
    const version = h.m.view.version("refused-delete");
    h.mi.bridge.request = async () => { throw new Error("delete refused"); };
    await expect(h.m.deleteSession("refused-delete")).rejects.toThrow("delete refused");
    expect(h.m.view.version("refused-delete")).toBe(version);
    expect(h.m.view.meta("refused-delete").title).toBe("keep");
    expect(h.frames.every((f) => f.t === "patch")).toBe(true);
  });

  it("seeds adopted runtime truth without rewriting a stable snapshot", () => {
    const h = harness("adopted");
    h.mi.sessions.get("adopted").running = true;
    h.mi.pendingRequests.set("adopted-request", { requestId: "adopted-request", sessionId: "adopted", method: "permission", params: {}, createdAt: 1 });
    const snap = h.m.viewSnapshot("adopted");
    expect(snap.meta.running).toBe(true);
    expect(snap.meta.runningSince).toBeTypeOf("number");
    expect(snap.meta.items).toHaveLength(1);
    expect(h.m.viewSnapshot("adopted")).toEqual(snap);
  });
});


describe("persisted region sequence continuity", () => {
  it.each(["provisional", "retained"] as const)("floors the first live event above restored %s items", async (region) => {
    const { itemLogSave, itemLogFinalize } = await import("../lib/itemLog");
    const { applyItemsFrame, emptySessionState, renderItems } = await import("../lib/client/model");
    const { checkIntegrity } = await import("../lib/client/integrity");
    const sid = `sequence-${region}`;
    const old: AssembledItem = { id: "p-old-0", kind: "text", role: "thought", text: "old thought", done: true, seqFrom: 800, seqTo: 900 };
    itemLogSave(sid, "old", 10, [old]);
    if (region === "retained") itemLogFinalize(sid, "old", new Map([[old.id, 10]]));
    const m = manager();
    // No snapshot/subscription before the first event: restoration must beat allocation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    mi.sessions.set(sid, { sessionId: sid, running: true, queue: [] });
    mi.emit(sid, "session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new answer" } });
    const first = m.provisional(sid).at(-1)!;
    expect(first.seqFrom).toBeGreaterThan(old.seqTo);
    const priorRevision = first.seqTo;
    mi.emit(sid, "session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " continued" } });
    expect(m.provisional(sid).at(-1)!.seqTo).toBeGreaterThan(priorRevision);
    const state = emptySessionState();
    state.durable = [{ id: "bf-10", kind: "text", role: "agent", text: "durable", done: true }];
    applyItemsFrame(state, { provisional: m.provisional(sid), retained: m.retained(sid), durableThrough: 10 });
    expect(checkIntegrity(renderItems(state)).disorder).toEqual([]);
  });
});

it("keeps merged one-shot metadata through patch eviction and forgets its store entry on delete", async () => {
  const h = harness("caps-survive");
  const before = h.m.view.size;
  h.mi.emit("caps-survive", "session_update", { sessionUpdate: "current_mode_update", currentModeId: "code", availableModes: [{ id: "code", name: "Code" }, { id: "plan", name: "Plan" }] });
  h.mi.emit("caps-survive", "session_update", { sessionUpdate: "current_mode_update", currentModeId: "plan" });
  h.mi.emit("caps-survive", "session_update", { sessionUpdate: "config_option_update", configOptions: [{ id: "model" }] });
  h.mi.emit("caps-survive", "session_update", { sessionUpdate: "available_commands_update", availableCommands: [{ name: "rename" }] });
  for (let i = 0; i < 300; i++) h.m.view.setMeta("caps-survive", { title: `${i}` });
  expect(h.m.viewSince("caps-survive", 1)).toBeNull();
  expect(h.m.viewSnapshot("caps-survive").meta).toMatchObject({
    modeId: "plan", modes: [{ id: "code", name: "Code" }, { id: "plan", name: "Plan" }],
    configOptions: [{ id: "model" }], commands: [{ name: "rename" }],
  });
  await h.m.deleteSession("caps-survive");
  expect(h.m.view.size).toBe(before - 1);
  expect(h.m.viewSnapshot("caps-survive").meta.modeId).toBeUndefined();
});

it("advances a restored open item's revision on the first new chunk before any read", async () => {
  const { itemLogSave } = await import("../lib/itemLog");
  const { itemRev } = await import("../lib/acp/itemAssembler");
  const old: AssembledItem = { id: "p-open-0", kind: "text", role: "agent", text: "prefix", done: false, seqFrom: 700, seqTo: 900 };
  itemLogSave("open-revision", "open", 10, [old]);
  const m = manager();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (m as any).emit("open-revision", "session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " suffix" } });
  const current = m.provisional("open-revision");
  expect(current).toHaveLength(1);
  expect(current[0]).toMatchObject({ id: old.id, text: "prefix suffix", seqFrom: 700 });
  expect(current[0].seqTo).toBeGreaterThan(old.seqTo);
  expect(itemRev(current[0])).not.toBe(itemRev(old));
});
