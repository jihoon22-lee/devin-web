import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { createSessionsDb } from "./fixtures/sessions-db";
import * as itemLog from "../lib/itemLog";
import { TurnRegions, type TurnRegionDeps } from "../lib/acp/turnRegions";
import { maxNodeId, nodesAfter } from "../lib/db";
import { rowToItem } from "../lib/transcript";

const cliDir = process.env.DEVIN_CLI_DIR!;
const stateDir = process.env.DEVIN_WEB_STATE_DIR!;
const configDir = dirname(process.env.DEVIN_WEB_DEVIN_CONFIG!);
const db = createSessionsDb(cliDir);
beforeEach(() => {
  vi.useFakeTimers();
  db.exec("DELETE FROM message_nodes; DELETE FROM sessions");
  itemLog.itemLogForget("late");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
afterAll(() => {
  db.close(); itemLog.itemLogResetForTests();
  for (const dir of [cliDir, stateDir, configDir]) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  let seq = 0;
  const deps: TurnRegionDeps = {
    maxNode: sid => maxNodeId(db, sid),
    spineRows: (sid, after, through) => nodesAfter(db, sid, after)
      .filter(row => row.node_id <= through).map(rowToItem)
      .filter(item => item != null).map(item => ({
        nodeId: Number(item.id),
        role: item.role === "user" ? "user" : item.role === "tool" ? "tool" : "agent",
        toolCallId: item.toolCallId,
      })),
    running: () => true, publish: vi.fn(), pokeDurable: vi.fn(),
    watchDurable: vi.fn(), invalidateDurable: vi.fn(),
    floorSeq: floor => { seq = Math.max(seq, floor); }, nextSeq: () => ++seq,
    finalToolUpdates: () => [],
    storage: { restore: itemLog.itemLogRestore, loadRetained: itemLog.itemLogLoadRetained,
      save: itemLog.itemLogSave, clearExcept: itemLog.itemLogClearExcept,
      drop: itemLog.itemLogDrop, finalize: itemLog.itemLogFinalize,
      pruneRetained: itemLog.itemLogPruneRetained, forget: itemLog.itemLogForget },
  };
  const regions = new TurnRegions(deps, "late-review");
  const feed = (type: string, data: unknown) => regions.feed({ seq: ++seq, sessionId: "late", type, data });
  const content = (sessionUpdate: string, text: string) => feed("session_update", {
    sessionUpdate, content: sessionUpdate === "user_message" ? [{ type: "text", text }] : { type: "text", text },
  });
  const commit = (id: number, role: string) => db.prepare(
    "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES ('late',?,NULL,?,1)",
  ).run(id, JSON.stringify({ message_id: `m-${id}`, role, content: `row-${id}` }));
  return { regions, deps, feed, content, commit };
}

// No failed write or alignment exception: only a legal separation between
// the ACP completion frame and the independent sessions.db commit watcher.
it("preserves closed thoughts/plans when the next prompt precedes the previous SQLite commit", () => {
  const { regions, deps, feed, content, commit } = harness();
  commit(100, "assistant");
  regions.beginTurn("late");
  content("user_message", "first prompt");
  content("agent_thought_chunk", "first thought");
  feed("session_update", { sessionUpdate: "plan", entries: [{ content: "first plan", status: "completed" }] });
  content("agent_message_chunk", "first answer");
  feed("turn_end", {});
  vi.advanceTimersByTime(40);
  expect(itemLog.itemLogRestore("late")?.ended).toBe(true);

  // The manager keeps the next prompt in its persisted queue, without an
  // echo, until the prior region's durable boundary can be established.
  expect(regions.beginTurn("late")).toBeUndefined();
  expect(regions.provisional("late").filter(item => item.role === "user")).toHaveLength(1);
  commit(101, "user"); commit(110, "assistant");
  regions.onDurableChange();
  expect(regions.beginTurn("late")).toBeDefined();
  content("user_message", "second prompt");
  content("agent_thought_chunk", "second thought");
  expect(regions.provisional("late").filter(item => item.role === "user")).toHaveLength(1);
  content("agent_message_chunk", "second answer");
  commit(111, "user"); commit(120, "assistant");
  feed("turn_end", {});
  vi.advanceTimersByTime(40);

  // Reopen the real itemlog, proving retention beyond this process's memory.
  itemLog.itemLogResetForTests();
  const restarted = new TurnRegions(deps, "late-restart");
  expect(restarted.retained("late")).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: "thought", text: "first thought", anchorNode: 101 }),
    expect.objectContaining({ kind: "plan", entries: [{ content: "first plan", status: "completed" }], anchorNode: 101 }),
    expect.objectContaining({ role: "thought", text: "second thought", anchorNode: 111 }),
  ]));
});

it.each(["turn_end", "turn_error"])("a substantive %s stays recoverable without assuming an absent future commit", type => {
  const { regions, deps, feed, content, commit } = harness();
  regions.beginTurn("late");
  content("user_message", "first prompt"); content("agent_thought_chunk", "keep after cancellation/error");
  feed(type, { stopReason: "cancelled" });
  // No 40ms flush has run: the gate must persist the closed snapshot now.
  expect(regions.beginTurn("late")).toBeUndefined();
  expect(regions.beginTurn("late")).toBeUndefined();
  itemLog.itemLogResetForTests();
  const restarted = new TurnRegions(deps, "cancel-restart");
  expect(restarted.provisional("late")).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: "keep after cancellation/error", done: true }),
  ]));
  expect(restarted.beginTurn("late")).toBeUndefined();
  commit(1, "user"); commit(2, "assistant");
  expect(restarted.beginTurn("late")).toBeDefined();
  expect(restarted.retained("late")).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: "keep after cancellation/error", anchorNode: 1 }),
  ]));
});

it.each(["turn_end", "turn_error"])("an empty %s permits the next prompt without a DB commit", type => {
  const { regions, feed } = harness();
  regions.beginTurn("late"); feed(type, {});
  expect(regions.turnStartNode("late")).toBeNull();
  expect(regions.beginTurn("late")).toBeDefined();
});

it.each(["turn_end", "turn_error"])("a user-echo-only %s permits the next prompt without a DB commit", type => {
  const { regions, feed, content } = harness();
  regions.beginTurn("late"); content("user_message", "cancelled before agent work"); feed(type, {});
  expect(regions.beginTurn("late")).toBeDefined();
});
