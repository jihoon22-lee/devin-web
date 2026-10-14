import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../lib/sqlite";
import * as itemLog from "../lib/itemLog";
import { FINALIZE_GRACE_MS, TURN_STALL_ALERT_MS, TurnRegions, type TurnRegionDeps } from "../lib/acp/turnRegions";
import type { AssembledItem } from "../lib/acp/itemAssembler";
import type { DurableSpineRow } from "../lib/acp/alignSpine";
import { integrityCount } from "../lib/integrityBeacon";

const fixtureStateDir = process.env.DEVIN_WEB_STATE_DIR!;
afterAll(() => {
  itemLog.itemLogResetForTests();
  rmSync(fixtureStateDir, { recursive: true, force: true });
});

function harness() {
  let tip = 100;
  let seq = 0;
  let restored: ReturnType<TurnRegionDeps["storage"]["restore"]> = null;
  let kept: AssembledItem[] = [];
  const deps: TurnRegionDeps = {
    maxNode: () => tip,
    spineRows: () => [{ nodeId: 101, role: "user" }, { nodeId: 110, role: "agent" }],
    running: () => true,
    publish: vi.fn(),
    pokeDurable: vi.fn(),
    watchDurable: vi.fn(),
    invalidateDurable: vi.fn(),
    floorSeq: (floor) => { seq = Math.max(seq, floor); },
    nextSeq: () => ++seq,
    finalToolUpdates: vi.fn(() => []),
    storage: {
      restore: () => restored,
      loadRetained: () => kept,
      save: vi.fn(),
      clearExcept: vi.fn(),
      drop: vi.fn(),
      finalize: vi.fn(),
      pruneRetained: vi.fn(),
      forget: vi.fn(() => { restored = null; kept = []; }),
    },
  };
  const r = new TurnRegions(deps, "rt");
  const feed = (type: string, data: unknown) => {
    r.ensureProvisional("s"); // manager restores before assigning the event's revision
    r.feed({ seq: ++seq, sessionId: "s", type, data });
  };
  return { r, deps, feed, tip: (n: number) => { tip = n; },
    restore: (value: typeof restored) => { restored = value; },
    retain: (items: AssembledItem[]) => { kept = items; } };
}
const thought = (seqTo = 50): AssembledItem => ({
  id: "p-old-1", kind: "text", role: "thought", text: "thinking", done: false,
  seqFrom: seqTo, seqTo,
});

afterEach(() => vi.useRealTimers());

describe("TurnRegions with injected storage and durable state", () => {
  it.each([false, true])("preserves a failed finalization at the next turn boundary (storage recovered: %s)", (recovered) => {
    vi.useFakeTimers();
    const { r, deps, feed, tip } = harness();
    deps.storage = { restore: itemLog.itemLogRestore, loadRetained: itemLog.itemLogLoadRetained,
      save: itemLog.itemLogSave, clearExcept: itemLog.itemLogClearExcept, drop: itemLog.itemLogDrop,
      finalize: itemLog.itemLogFinalize, pruneRetained: itemLog.itemLogPruneRetained, forget: itemLog.itemLogForget };
    itemLog.itemLogForget("s");
    r.beginTurn("s");
    feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "keep at next turn" } });
    vi.advanceTimersByTime(40);
    const db = openDb(join(fixtureStateDir, "itemlog.db"));
    try {
      db.exec(`CREATE TRIGGER fail_next_turn BEFORE INSERT ON items WHEN NEW.done = 1
        BEGIN SELECT RAISE(ABORT, 'temporary write failure'); END`);
      tip(110); feed("turn_end", {});
      if (recovered) db.exec("DROP TRIGGER fail_next_turn");
      const next = r.beginTurn("s");
      if (recovered) {
        expect(next).toBeDefined();
        expect(r.retained("s")).toMatchObject([{ text: "keep at next turn", done: true }]);
      } else {
        expect(next).toBeUndefined();
        expect(r.provisional("s")).toMatchObject([{ text: "keep at next turn", done: true }]);
      }
      itemLog.itemLogResetForTests();
      if (recovered) expect(itemLog.itemLogLoadRetained("s")).toMatchObject([{ text: "keep at next turn" }]);
      else expect(itemLog.itemLogRestore("s")?.items).toMatchObject([{ text: "keep at next turn" }]);
    } finally { db.exec("DROP TRIGGER IF EXISTS fail_next_turn"); db.close(); itemLog.itemLogForget("s"); }
  });

  it("retries a transient alignment failure before replacing the ended turn", () => {
    const { r, deps, feed, tip } = harness();
    const rows = deps.spineRows;
    deps.spineRows = vi.fn().mockImplementationOnce(() => { throw new Error("temporary read error"); }).mockImplementation(rows);
    r.beginTurn("s");
    feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "keep alignment" } });
    tip(110); feed("turn_end", {});
    expect(r.beginTurn("s")).toBeDefined();
    expect(r.retained("s")).toMatchObject([{ text: "keep alignment", done: true }]);
  });

  it.each([false, true])("persists the final unflushed region across SQLite reopen (prior flush: %s)", (flush) => {
    vi.useFakeTimers();
    const { r, deps, feed, tip } = harness();
    deps.storage = { restore: itemLog.itemLogRestore, loadRetained: itemLog.itemLogLoadRetained,
      save: itemLog.itemLogSave, clearExcept: itemLog.itemLogClearExcept, drop: itemLog.itemLogDrop,
      finalize: itemLog.itemLogFinalize, pruneRetained: itemLog.itemLogPruneRetained, forget: itemLog.itemLogForget };
    itemLog.itemLogForget("s");
    r.beginTurn("s");
    feed("session_update", { sessionUpdate: "user_message", content: [{ type: "text", text: "go" }] });
    feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "first" } });
    if (flush) vi.advanceTimersByTime(40);
    feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " last" } });
    feed("session_update", { sessionUpdate: "plan", entries: [{ content: "latest", status: "completed" }] });
    tip(110);
    feed("turn_end", {});
    const expected = r.retained("s");
    expect(expected).toHaveLength(2);
    vi.advanceTimersByTime(40);
    itemLog.itemLogResetForTests();
    const restarted = new TurnRegions(deps, "restart");
    expect(restarted.retained("s")).toEqual(expected);
    expect(restarted.provisional("s")).toEqual([]);
    itemLog.itemLogForget("s");
    itemLog.itemLogResetForTests();
  });

  it("retries a failed real SQLite finalization without releasing the watermark or losing the last update", () => {
    vi.useFakeTimers();
    const { r, deps, feed, tip } = harness();
    deps.storage = { restore: itemLog.itemLogRestore, loadRetained: itemLog.itemLogLoadRetained,
      save: itemLog.itemLogSave, clearExcept: itemLog.itemLogClearExcept, drop: itemLog.itemLogDrop,
      finalize: itemLog.itemLogFinalize, pruneRetained: itemLog.itemLogPruneRetained, forget: itemLog.itemLogForget };
    itemLog.itemLogForget("s");
    r.beginTurn("s");
    feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "first" } });
    vi.advanceTimersByTime(40);
    const db = openDb(join(fixtureStateDir, "itemlog.db"));
    try {
      db.exec(`CREATE TRIGGER fail_final BEFORE INSERT ON items WHEN NEW.done = 1
        BEGIN SELECT RAISE(ABORT, 'injected finalization failure'); END`);
      feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " last" } });
      tip(110);
      feed("turn_end", {});
      expect(r.provisional("s")).toMatchObject([{ text: "first last", done: true }]);
      expect(r.durableThrough("s")).toBe(100);
      expect(itemLog.itemLogRestore("s")?.items).toMatchObject([{ text: "first", done: false }]);
      expect(itemLog.itemLogLoadRetained("s")).toEqual([]);
      db.exec("DROP TRIGGER fail_final");
      r.onDurableChange();
      expect(r.durableThrough("s")).toBe(110);
      expect(r.provisional("s")).toEqual([]);
      itemLog.itemLogResetForTests();
      const restarted = new TurnRegions(deps, "retry-restart");
      expect(restarted.retained("s")).toEqual(r.retained("s"));
      expect(restarted.retained("s")).toMatchObject([{ text: "first last", done: true }]);
    } finally { db.close(); }
  });

  it("keeps the ended region until failed finalization can be retried", () => {
    const { r, deps, feed, tip } = harness();
    vi.mocked(deps.storage.finalize).mockReturnValueOnce(false).mockReturnValue(true);
    r.beginTurn("s");
    feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "keep" } });
    tip(110);
    feed("turn_end", {});
    expect(r.provisional("s")).toHaveLength(1);
    expect(r.retained("s")).toEqual([]);
    expect(r.durableThrough("s")).toBe(100);
    r.onDurableChange();
    expect(r.provisional("s")).toEqual([]);
    expect(r.retained("s")).toHaveLength(1);
  });

  it("freezes the watermark at turn start", () => {
    const { r, tip } = harness();
    r.beginTurn("s");
    tip(130);
    expect(r.durableThrough("s")).toBe(100);
    expect(r.turnStartNode("s")).toBe(100);
  });

  it("retires a covered ended turn and retains thoughts at their durable anchor", () => {
    const { r, deps, feed, tip } = harness();
    r.beginTurn("s");
    feed("session_update", { sessionUpdate: "user_message", content: [{ type: "text", text: "go" }] });
    feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    feed("turn_end", null);
    expect(r.provisional("s")).toHaveLength(2);
    tip(110);
    r.onDurableChange();
    expect(r.provisional("s")).toEqual([]);
    expect(r.retained("s")).toEqual([expect.objectContaining({ role: "thought", anchorNode: 101, done: true })]);
    expect(r.durableThrough("s")).toBe(110);
    expect(deps.publish).toHaveBeenLastCalledWith("s", { provisional: [], retained: r.retained("s"), durableThrough: 110 });
    expect(deps.pokeDurable).toHaveBeenCalledOnce();
  });

  it("strips plan revisions when the turn flips to retained", () => {
    const { r, feed, tip } = harness();
    r.beginTurn("s");
    feed("session_update", { sessionUpdate: "user_message", content: [{ type: "text", text: "go" }] });
    feed("session_update", { sessionUpdate: "plan", entries: [{ content: "a", status: "pending" }] });
    feed("session_update", { sessionUpdate: "plan", entries: [{ content: "a", status: "in_progress" }] });
    feed("session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
    const live = r.provisional("s").find((i) => i.kind === "plan");
    expect(live?.revisions).toHaveLength(2);
    feed("turn_end", {});
    tip(110);
    r.onDurableChange();
    const ret = r.retained("s");
    expect(ret).toHaveLength(1);
    expect(ret[0]).toMatchObject({ kind: "plan", anchorNode: 101 });
    expect(ret[0].revisions).toBeUndefined();
  });

  it("forgets both regions and pending flushes while idle watermark follows the DB", () => {
    vi.useFakeTimers();
    const { r, deps, feed, retain } = harness();
    retain([{ ...thought(), anchorNode: 90 }]);
    r.beginTurn("s");
    feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "new" } });
    r.forget("s");
    vi.advanceTimersByTime(40);
    expect(r.provisional("s")).toEqual([]);
    expect(r.retained("s")).toEqual([]);
    expect(r.turnStartNode("s")).toBeNull();
    expect(r.durableThrough("s")).toBe(100);
    expect(deps.storage.forget).toHaveBeenCalledWith("s");
    expect(deps.invalidateDurable).toHaveBeenCalledWith("s");
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.storage.save).not.toHaveBeenCalled();
  });

  it("restores the earlier watermark on adoption and floors revisions from both regions", () => {
    const { r, restore, retain, feed } = harness();
    restore({ turnId: "old", startNode: 40, ended: false, items: [thought(80)] });
    retain([{ ...thought(90), id: "p-older-1", anchorNode: 30 }]);
    r.adoptRunningTurn("s");
    feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " more" } });
    expect(r.durableThrough("s")).toBe(40);
    expect(r.provisional("s").at(-1)?.seqTo).toBe(91);
  });

  it("reconciles restored open tools with a fresh revision before new events", () => {
    const { r, deps, restore, feed } = harness();
    restore({ turnId: "old", startNode: 40, ended: false, items: [{
      id: "p-old-1", kind: "tool", done: false, seqFrom: 80, seqTo: 80,
      tool: { toolCallId: "call", status: "in_progress", title: "run" },
    }] });
    vi.mocked(deps.finalToolUpdates).mockReturnValue([{ sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed" }]);
    feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "after" } });
    expect(deps.finalToolUpdates).toHaveBeenCalledWith("s", ["call"]);
    expect(r.provisional("s")).toEqual([
      expect.objectContaining({ id: "p-old-1", seqTo: 81, tool: expect.objectContaining({ status: "completed" }) }),
      expect.objectContaining({ role: "thought", seqTo: 82 }),
    ]);
  });

  it("coalesces flushes and omits retained data during ordinary streaming", () => {
    vi.useFakeTimers();
    const { r, deps, feed } = harness();
    r.beginTurn("s");
    for (const text of ["one", "two"]) feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
    vi.advanceTimersByTime(40);
    expect(deps.publish).toHaveBeenCalledExactlyOnceWith("s", { provisional: r.provisional("s"), durableThrough: 100 });
    expect(deps.storage.save).toHaveBeenCalledExactlyOnceWith("s", "trt-1", 100, r.provisional("s"), false);
  });

  it("invalidates the durable cache before checking an ended turn's coverage", () => {
    const { r, deps, feed, tip } = harness();
    r.beginTurn("s");
    feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    feed("turn_end", {});
    vi.mocked(deps.invalidateDurable).mockImplementation(() => tip(110));
    r.onDurableChange();
    expect(r.provisional("s")).toEqual([]);
    expect(r.durableThrough("s")).toBe(110);
  });
});

/** A turn whose mid-turn rows (user + tool) are durable while the final
 *  agent answer's row lags the ACP prompt response. */
function laggingTurn(restored: ReturnType<TurnRegionDeps["storage"]["restore"]> = null) {
  let tip = 100;
  let seq = 0;
  const rows: DurableSpineRow[] = [{ nodeId: 101, role: "user" }, { nodeId: 102, role: "tool", toolCallId: "t1" }];
  const deps: TurnRegionDeps = {
    maxNode: () => tip,
    spineRows: (_sid, after, through) => rows.filter((r) => r.nodeId > after && r.nodeId <= through),
    running: () => true,
    publish: vi.fn(),
    pokeDurable: vi.fn(),
    watchDurable: vi.fn(),
    invalidateDurable: vi.fn(),
    floorSeq: (f) => { seq = Math.max(seq, f); },
    nextSeq: () => ++seq,
    finalToolUpdates: vi.fn(() => []),
    storage: {
      restore: () => restored, loadRetained: () => [], save: vi.fn(), clearExcept: vi.fn(),
      drop: vi.fn(), finalize: vi.fn(), pruneRetained: vi.fn(), forget: vi.fn(),
    },
  };
  const r = new TurnRegions(deps, "lag");
  const feed = (type: string, data: unknown) => r.feed({ seq: ++seq, sessionId: "s", type, data });
  const play = () => {
    r.beginTurn("s");
    feed("session_update", { sessionUpdate: "user_message", content: [{ type: "text", text: "q" }] });
    feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    feed("session_update", { sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", status: "pending" });
    feed("session_update", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    feed("session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FINAL ANSWER" } });
  };
  return { r, deps, feed, play, rows, setTip: (n: number) => { tip = n; } };
}

describe("M1: final agent row lagging the prompt response", () => {
  it("keeps the region until the last agent row commits, then finalizes", () => {
    vi.useFakeTimers();
    const h = laggingTurn();
    h.play();
    h.setTip(102); // mid-turn rows durable, final answer not yet
    h.feed("turn_end", {});
    expect(h.r.provisional("s").map((i) => i.text)).toContain("FINAL ANSWER");
    expect(h.r.durableThrough("s")).toBe(100);
    expect(h.r.awaitingCommit("s")).toBe(true);
    expect(h.r.beginTurn("s")).toBeUndefined(); // next prompt waits in the queue
    h.rows.push({ nodeId: 103, role: "agent" });
    h.setTip(103);
    h.r.onDurableChange();
    expect(h.r.provisional("s")).toEqual([]);
    expect(h.r.retained("s").map((i) => [i.text, i.anchorNode])).toEqual([["thinking", 101]]);
    expect(h.r.durableThrough("s")).toBe(103);
    expect(h.r.awaitingCommit("s")).toBe(false);
  });

  it("finalizes after the grace window when the row never commits (grace expiry)", () => {
    vi.useFakeTimers();
    const before = integrityCount().total;
    const h = laggingTurn();
    h.play();
    h.setTip(102);
    h.feed("turn_end", {});
    vi.advanceTimersByTime(FINALIZE_GRACE_MS);
    expect(h.r.provisional("s")).toEqual([]);
    expect(integrityCount()).toMatchObject({ total: before + 1, lastSig: "server:finalizeUnaligned" });
    expect(h.r.beginTurn("s")).toBeDefined();
  });

  it("a restored, partially covered ended turn finalizes without a grace wait (restored)", () => {
    vi.useFakeTimers();
    const before = integrityCount().total;
    const h = laggingTurn({
      turnId: "told", startNode: 100, ended: true,
      items: [{ id: "p-told-1", kind: "text", role: "agent", text: "OLD ANSWER", done: true, seqFrom: 1, seqTo: 1 }],
    });
    h.setTip(102);
    expect(h.r.provisional("s")).toEqual([]);
    expect(integrityCount().total).toBe(before + 1);
  });

  it("forget during grace cancels the pending re-check (forget during grace)", () => {
    vi.useFakeTimers();
    const h = laggingTurn();
    h.play();
    h.setTip(102);
    h.feed("turn_end", {});
    h.r.forget("s");
    const published = (h.deps.publish as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(() => vi.advanceTimersByTime(FINALIZE_GRACE_MS)).not.toThrow();
    expect((h.deps.publish as ReturnType<typeof vi.fn>).mock.calls.length).toBe(published);
    expect(h.r.awaitingCommit("s")).toBe(false);
  });

  it("a user-echo-only ending does not wait for a commit", () => {
    const h = laggingTurn();
    h.r.beginTurn("s");
    h.feed("session_update", { sessionUpdate: "user_message", content: [{ type: "text", text: "q" }] });
    h.setTip(102);
    h.feed("turn_end", {});
    expect(h.r.awaitingCommit("s")).toBe(false);
    expect(h.r.provisional("s")).toEqual([]);
  });
});

describe("stalled ended turn (no durable row)", () => {
  it("alarms once after TURN_STALL_ALERT_MS while the turn stays withheld", () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const before = integrityCount().total;
      const h = laggingTurn();
      h.play();
      h.feed("turn_end", {}); // tip stays at turnStartNode: no row ever lands
      vi.advanceTimersByTime(TURN_STALL_ALERT_MS);
      expect(integrityCount()).toMatchObject({ total: before + 1, lastSig: "server:turnStalled" });
      expect(error.mock.calls.filter((c) => String(c[0]).includes("turnStalled"))).toHaveLength(1);
      vi.advanceTimersByTime(10 * 60_000);
      expect(integrityCount().total).toBe(before + 1); // one report per stalled turn
      // finalization semantics unchanged: the answer is still held and the
      // next prompt still waits for a durable row
      expect(h.r.provisional("s").map((i) => i.text)).toContain("FINAL ANSWER");
      expect(h.r.beginTurn("s")).toBeUndefined();
    } finally { error.mockRestore(); }
  });

  it("does not alarm when a row lands before the delay", () => {
    vi.useFakeTimers();
    const before = integrityCount().total;
    const h = laggingTurn();
    h.play();
    h.feed("turn_end", {});
    h.rows.push({ nodeId: 103, role: "agent" });
    h.setTip(103);
    h.r.onDurableChange(); // the closing row lands — the normal flip retires it
    expect(h.r.provisional("s")).toEqual([]);
    vi.advanceTimersByTime(TURN_STALL_ALERT_MS * 2);
    expect(integrityCount().total).toBe(before);
  });

  it("does not alarm for a user-echo-only ending", () => {
    vi.useFakeTimers();
    const before = integrityCount().total;
    const h = laggingTurn();
    h.r.beginTurn("s");
    h.feed("session_update", { sessionUpdate: "user_message", content: [{ type: "text", text: "q" }] });
    h.feed("turn_end", {});
    vi.advanceTimersByTime(TURN_STALL_ALERT_MS * 2);
    expect(integrityCount().total).toBe(before);
    expect(h.r.beginTurn("s")).toBeDefined(); // nothing to preserve — never blocked
  });

  it("forget before the delay silences the alarm", () => {
    vi.useFakeTimers();
    const before = integrityCount().total;
    const h = laggingTurn();
    h.play();
    h.feed("turn_end", {});
    h.r.forget("s");
    expect(() => vi.advanceTimersByTime(TURN_STALL_ALERT_MS * 2)).not.toThrow();
    expect(integrityCount().total).toBe(before);
  });

  it("alarms for an ended region restored without durable coverage", () => {
    vi.useFakeTimers();
    const before = integrityCount().total;
    const h = laggingTurn({
      turnId: "told", startNode: 100, ended: true,
      items: [{ id: "p-told-1", kind: "text", role: "agent", text: "OLD ANSWER", done: true, seqFrom: 1, seqTo: 1 }],
    });
    expect(h.r.provisional("s").map((i) => i.text)).toContain("OLD ANSWER"); // triggers the restore
    vi.advanceTimersByTime(TURN_STALL_ALERT_MS);
    expect(integrityCount()).toMatchObject({ total: before + 1, lastSig: "server:turnStalled" });
  });

  it("does not alarm while the grace path owns a lagging closing row", () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const before = integrityCount().total;
      const h = laggingTurn();
      h.play();
      h.setTip(102); // mid-turn rows durable — maxNode > turnStartNode
      h.feed("turn_end", {});
      vi.advanceTimersByTime(FINALIZE_GRACE_MS); // grace expires -> finalizeUnaligned flip
      expect(integrityCount()).toMatchObject({ total: before + 1, lastSig: "server:finalizeUnaligned" });
      vi.advanceTimersByTime(TURN_STALL_ALERT_MS);
      expect(integrityCount().total).toBe(before + 1);
      expect(error.mock.calls.filter((c) => String(c[0]).includes("turnStalled"))).toHaveLength(0);
    } finally { error.mockRestore(); }
  });
});
