import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnRegions, type TurnRegionDeps } from "../lib/acp/turnRegions";
import type { AssembledItem } from "../lib/acp/itemAssembler";

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
