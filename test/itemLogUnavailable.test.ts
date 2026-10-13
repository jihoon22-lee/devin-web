import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic state dir — env must be set before lib/* modules are imported.
const stateDir = mkdtempSync(join(tmpdir(), "dw-state-itemlog-down-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;

const { itemLogFinalize, itemLogSave, itemLogResetForTests } =
  await import("../lib/itemLog");
const { openDb } = await import("../lib/sqlite");
import { TurnRegions, type TurnRegionDeps } from "../lib/acp/turnRegions";
import type { AssembledItem } from "../lib/acp/itemAssembler";

afterAll(() => {
  itemLogResetForTests();
  rmSync(stateDir, { recursive: true, force: true });
});

const doneThought: AssembledItem = {
  id: "p-1", kind: "text", role: "thought", text: "keep",
  done: true, seqFrom: 1, seqTo: 1,
};

describe("itemLog unavailable", () => {
  it("an unopenable itemlog.db makes finalize succeed (nothing to preserve) and save a no-op", () => {
    // A directory where the db file belongs — DatabaseSync cannot open it, so
    // db() latches broken. An unavailable log must never wedge a turn.
    mkdirSync(join(stateDir, "itemlog.db"));
    expect(itemLogFinalize("s1", "t1", new Map([["x", 1]]))).toBe(true);
    expect(() => itemLogSave("s1", "t1", 0, [doneThought])).not.toThrow();
    rmSync(join(stateDir, "itemlog.db"), { recursive: true });
    itemLogResetForTests();
  });

  it("still returns false on a real write failure once the db is open", () => {
    itemLogSave("s1", "t0", 0, []); // force the module's db open + schema first
    const d = openDb(join(stateDir, "itemlog.db"));
    d.exec(`CREATE TRIGGER reject_done BEFORE INSERT ON items WHEN NEW.done = 1
      BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`);
    try {
      const latest = { startNode: 10, items: [doneThought] };
      expect(itemLogFinalize("s1", "t1", new Map([["p-1", 10]]), latest)).toBe(false);
      d.exec("DROP TRIGGER reject_done");
      expect(itemLogFinalize("s1", "t1", new Map([["p-1", 10]]), latest)).toBe(true);
    } finally {
      d.exec("DROP TRIGGER IF EXISTS reject_done");
      d.close();
    }
  });
});

describe("TurnRegions with an unavailable itemlog", () => {
  function harness() {
    let tip = 100;
    let seq = 0;
    const deps: TurnRegionDeps = {
      maxNode: () => tip,
      spineRows: () => [
        { nodeId: 101, role: "user" },
        { nodeId: 110, role: "agent" },
      ],
      running: () => true,
      publish: vi.fn(),
      pokeDurable: vi.fn(),
      watchDurable: vi.fn(),
      invalidateDurable: vi.fn(),
      floorSeq: (floor) => { seq = Math.max(seq, floor); },
      nextSeq: () => ++seq,
      finalToolUpdates: () => [],
      storage: {
        restore: () => null,
        loadRetained: () => [],
        save: vi.fn(),
        clearExcept: vi.fn(),
        drop: vi.fn(),
        finalize: () => true, // unavailable log: nothing to preserve, success
        pruneRetained: vi.fn(),
        forget: vi.fn(),
      },
    };
    const regions = new TurnRegions(deps, "unavail");
    const feed = (type: string, data: unknown) => {
      regions.ensureProvisional("s1");
      regions.feed({ seq: ++seq, sessionId: "s1", type, data });
    };
    return { regions, feed, tip: (n: number) => { tip = n; } };
  }

  it("retires the ended turn on durable coverage and unblocks the next turn", () => {
    const { regions, feed, tip } = harness();
    expect(regions.beginTurn("s1")).toBeDefined();
    expect(regions.durableThrough("s1")).toBe(100);
    feed("session_update", { sessionUpdate: "user_message", content: [{ type: "text", text: "go" }] });
    feed("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    feed("session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
    feed("turn_end", {});
    tip(110);
    regions.onDurableChange();
    // the flip retires the region even though nothing was persisted —
    // counterpart-less items survive in memory only
    expect(regions.provisional("s1")).toEqual([]);
    expect(regions.retained("s1")).toMatchObject([
      { role: "thought", text: "thinking", done: true, anchorNode: 101 },
    ]);
    expect(regions.durableThrough("s1")).toBe(110);
    expect(regions.beginTurn("s1")).toBeDefined();
    expect(regions.durableThrough("s1")).toBe(110);
  });
});
