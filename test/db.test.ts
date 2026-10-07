import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic mini corpus — both modules read env at import time, so set it
// before any (dynamic) import of lib/db or lib/searchIndex.
const cliDir = mkdtempSync(join(tmpdir(), "dw-cli-"));
const stateDir = mkdtempSync(join(tmpdir(), "dw-state-"));
process.env.DEVIN_CLI_DIR = cliDir;
process.env.DEVIN_WEB_STATE_DIR = stateDir;

const { DatabaseSync } = await import("node:sqlite");

const msg = (role: string, text: string, mid: string) =>
  JSON.stringify({ message_id: mid, role, content: [{ type: "text", text }] });

const sdb = new DatabaseSync(join(cliDir, "sessions.db"));
sdb.exec(`CREATE TABLE sessions(
  id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
  model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0)`);
sdb.exec(`CREATE TABLE message_nodes(
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id))`);

const insS = sdb.prepare(
  "INSERT INTO sessions(id,working_directory,backend_type,model,agent_mode,created_at,last_activity_at,title,main_chain_id,hidden) VALUES (?,?,?,?,?,?,?,?,?,?)",
);
const insN = sdb.prepare(
  "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
);

// s1: main chain 1→2→3; node 4 is a fork off 2 (must never appear on main
// chain). It is a USER message — an alternate prompt direction; assistant-role
// multi-child siblings are snapshot rewrites, not user-visible branches.
insS.run("s1", "/tmp/one", "local", "m", "default", 1, 1, "Session One", 3, 0);
insN.run("s1", 1, null, msg("user", "hello needle one", "m1"), 1);
insN.run("s1", 2, 1, msg("assistant", "answer haystack", "m2"), 2);
insN.run("s1", 3, 2, msg("user", "needle again", "m3"), 3);
insN.run("s1", 4, 2, msg("user", "forked needle branch", "m4"), 4);
// s5: snapshot-rewrite noise — every streaming message is rewritten under a
// fresh sibling node (same message_id, assistant role), so parent 2 has
// assistant children 4,5 that are NOT branches. Only user-input child 6 is.
insS.run("s5", "/tmp/five", "local", "m", "default", 1, 1, "Snapshots", 3, 0);
insN.run("s5", 1, null, msg("user", "snap base question", "n1"), 1);
insN.run("s5", 2, 1, msg("assistant", "answer", "n2"), 2);
insN.run("s5", 3, 2, msg("user", "snap followup", "n3"), 3);
insN.run("s5", 4, 2, msg("assistant", "streamed draft", "n4"), 4);
insN.run("s5", 5, 2, msg("assistant", "streamed draft longer", "n4"), 5);
insN.run("s5", 6, 2, msg("user", "snap alternate direction", "n6"), 6);
// s6: the real-data pattern — every streamed assistant message is rewritten
// as a SAME-parent sibling (same message_id), so each chain node has an id
// gap filled by its own stale drafts. The timeline must stay ONE segment
// and the drafts must never surface as branches or history.
insS.run("s6", "/tmp/six", "local", "m", "default", 1, 1, "Drafts", 5, 0);
insN.run("s6", 1, null, msg("user", "draft chain question", "d1"), 1);
insN.run("s6", 2, 1, msg("assistant", "draft v1", "d2"), 2);
insN.run("s6", 3, 1, msg("assistant", "draft v2", "d2"), 3);
insN.run("s6", 4, 1, msg("assistant", "final answer", "d2"), 4);
insN.run("s6", 5, 4, msg("user", "draft chain followup", "d5"), 5);
// s2: hidden session containing the same needle
insS.run("s2", "/tmp/two", "local", "m", "default", 1, 1, "Hidden", 1, 1);
insN.run("s2", 1, null, msg("user", "needle in hidden", "h1"), 5);
// s3: COMPACTED session — the CLI duplicated context into a fresh tree
// rooted at node 10 (parent NULL); the old conversation tree (1→2→3) is
// orphaned: unreachable via parent links from main_chain_id=12
insS.run("s3", "/tmp/three", "local", "m", "default", 1, 1, "Compacted", 12, 0);
insN.run("s3", 1, null, msg("user", "old hello", "o1"), 1);
insN.run("s3", 2, 1, msg("assistant", "old answer", "o2"), 2);
insN.run("s3", 3, 2, msg("user", "old followup", "o3"), 3);
insN.run("s3", 10, null, msg("system", "compressed context prefix", "c0"), 4);
insN.run("s3", 11, 10, msg("assistant", "summary of prior work", "c1"), 5);
insN.run("s3", 12, 11, msg("assistant", "new turn answer", "c2"), 6);
// s4: GRAFTED compaction — the new continuation's root (100) is a CHILD of
// old node 3, so the original continuation (4→5) becomes a dead branch in
// the numeric gap (3,100): unreachable by ancestry AND by root-hopping
insS.run("s4", "/tmp/four", "local", "m", "default", 1, 1, "Grafted", 102, 0);
insN.run("s4", 1, null, msg("system", "old tree root", "g0"), 1);
insN.run("s4", 2, 1, msg("system", "old context", "g1"), 2);
insN.run("s4", 3, 2, msg("system", "graft base", "g2"), 3);
insN.run("s4", 4, 3, msg("user", "old task prompt", "g3"), 4);
insN.run("s4", 5, 4, msg("assistant", "old task output", "g4"), 5);
insN.run("s4", 100, 3, msg("system", "compacted context", "g5"), 6);
insN.run("s4", 101, 100, msg("assistant", "post-compaction answer", "g6"), 7);
insN.run("s4", 102, 101, msg("user", "current question", "g7"), 8);

// s8: RE-ANCHORED rewrite — node 5 is dead-branch history, but its message
// (mid "g4") was rewritten onto the live chain at 101 under a DIFFERENT
// parent. The dead copy
// must never render alongside the chain copy.
insS.run("s8", "/tmp/eight", "local", "m", "default", 1, 1, "Reanchored", 102, 0);
insN.run("s8", 1, null, msg("system", "old tree root", "g0"), 1);
insN.run("s8", 2, 1, msg("system", "old context", "g1"), 2);
insN.run("s8", 3, 2, msg("system", "graft base", "g2"), 3);
insN.run("s8", 4, 3, msg("user", "old task prompt", "g3"), 4);
insN.run("s8", 5, 4, msg("assistant", "stale draft output", "g4"), 5);
insN.run("s8", 100, 3, msg("system", "compacted context", "g5"), 6);
insN.run("s8", 101, 100, msg("assistant", "final output", "g4"), 7); // same mid as node 5
insN.run("s8", 102, 101, msg("user", "current question", "g7"), 8);
// early: a new turn has committed its root and user row, but the durable
// watermark was frozen before either node existed.
insS.run("early", "/tmp/early", "local", "m", "default", 1, 1, "Early turn", 11, 0);
insN.run("early", 10, null, msg("system", "new root", "e0"), 1);
insN.run("early", 11, 10, msg("user", "new prompt", "e1"), 2);
// headless: old CLI data can have rows without a main_chain_id. A bound must
// still constrain its fallback scan; an omitted bound retains all rows.
insS.run("headless", "/tmp/headless", "local", "m", "default", 1, 1, "Headless", null, 0);
insN.run("headless", 1, null, msg("user", "legacy prompt", "l1"), 1);
insN.run("headless", 2, 1, msg("assistant", "legacy answer", "l2"), 2);
insN.run("headless", 10, null, msg("system", "legacy newer root", "l10"), 3);
insN.run("headless", 11, 10, msg("user", "legacy newer prompt", "l11"), 4);
// frozen-graft: the current turn grafts at 2 after the completed turn at
// 3–4. The frozen watermark is 4; choosing only current ancestry yields 2
// and strands retained thoughts anchored to 3–4 outside the snapshot.
insS.run("frozen-graft", "/tmp/frozen", "local", "m", "default", 1, 1, "Frozen graft", 101, 0);
for (const [id, parent, role] of [
  [1, null, "user"], [2, 1, "assistant"], [3, 2, "user"],
  [4, 3, "assistant"], [100, 2, "system"], [101, 100, "user"],
] as const) insN.run("frozen-graft", id, parent, msg(role, `message ${id}`, `fg${id}`), id);
insS.run("nested-graft", "/tmp/nested", "local", "m", "default", 1, 1, "Nested graft", 101, 0);
for (const [id, parent, role] of [
  [1, null, "user"], [2, 1, "assistant"], [3, 2, "user"], [4, 3, "assistant"],
  [10, 2, "system"], [11, 10, "user"], [12, 11, "assistant"],
  [20, 1, "system"], [21, 20, "user"], [22, 21, "assistant"],
  [100, 2, "system"], [101, 100, "user"],
] as const) insN.run("nested-graft", id, parent, msg(role, `nested ${id}`, `ng${id}`), id);
for (const [session, head] of [["root-after-grafts", 1001], ["headless-grafts", null]] as const) {
  insS.run(session, "/tmp/root-grafts", "local", "m", "default", 1, 1, "Root after grafts", head, 0);
  sdb.prepare(`INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at)
    SELECT ?,node_id,parent_node_id,chat_message,created_at FROM message_nodes WHERE session_id='nested-graft'`)
    .run(session);
  insN.run(session, 1000, null, msg("system", "fresh root", "root1000"), 1000);
  insN.run(session, 1001, 1000, msg("user", "fresh prompt", "root1001"), 1001);
}
sdb.close();

const { mainChainHead, mainChainRows, maxNodeId, nodesAfter, openSessionsDb, SESSION_ACTIVITY_SQL, sessionActivity } =
  await import("../lib/db");
const { ensureFtsSchema, ftsCanServe, indexNewRows, projectSessionIds, runMaintenance, searchFts, searchLike, sessionMeta } =
  await import("../lib/searchIndex");
const { readTranscriptDelta, readTranscriptItems } = await import("../lib/transcript-db");
const { branchTip, sessionSegments } = await import("../lib/treeIndex");
const { applyDurableDelta, applyViewFrame, emptySessionState, renderItems } = await import("../lib/client/model");
const { integrityBeacon } = await import("../lib/client/integrity");

describe("sessionSegments — work-history timeline", () => {
  it("splits a grafted compaction into pre/post segments", () => {
    // s4: dead branch 4→5 is parent-contiguous with the shared base, so it
    // merges into the pre-compaction segment; the graft child starts a new one
    const { segments } = sessionSegments("s4");
    expect(segments).toHaveLength(2);
    const [cur, old] = segments; // current segment pinned first
    expect(cur.isMain).toBe(true);
    expect(cur.base).toBe(5);
    expect(cur.tip).toBe(102);
    expect(cur.firstPrompt).toContain("current question");
    expect(old.isMain).toBe(false);
    expect(old.tip).toBe(5);
    expect(old.firstPrompt).toContain("old task prompt");
  });

  it("splits orphan compaction trees into segments", () => {
    // s3: fresh-root tree 10–12 + orphaned tree 1–3
    const { segments } = sessionSegments("s3");
    expect(segments.map((s) => s.tip)).toEqual([12, 3]);
    expect(segments[0].isMain).toBe(true);
    expect(segments[1].firstPrompt).toContain("old hello");
  });

  it("lists an off-chain side branch as a branch segment", () => {
    // s1: node 4 is a fork child of 2, never on the walked main chain
    const { segments } = sessionSegments("s1");
    expect(segments.find((s) => s.isMain)?.tip).toBe(3);
    const branch = segments.find((s) => s.tip === 4);
    expect(branch?.kind).toBe("branch");
    expect(branch?.base).toBe(2);
  });

  it("ignores snapshot-rewrite siblings — only user-input children branch", () => {
    // s5: assistant snapshot siblings 4,5 (same message_id) are not branches;
    // user-input child 6 is the one real alternate direction
    const { segments } = sessionSegments("s5");
    expect(segments.find((s) => s.isMain)?.tip).toBe(3);
    const tips = segments.map((s) => s.tip);
    expect(tips).not.toContain(4);
    expect(tips).not.toContain(5);
    const branch = segments.find((s) => s.tip === 6);
    expect(branch?.kind).toBe("branch");
    expect(branch?.firstPrompt).toContain("snap alternate direction");
  });

  it("rewrite-draft siblings do not fragment the timeline", () => {
    // s6: chain nodes 4 and 5 have id gaps filled only by their own stale
    // drafts — the whole session is ONE segment, drafts surface nowhere
    const { segments } = sessionSegments("s6");
    expect(segments).toHaveLength(1);
    expect(segments[0].isMain).toBe(true);
    expect(segments[0].tip).toBe(5);
    expect(segments[0].count).toBe(3);
    expect(segments[0].firstPrompt).toContain("draft chain question");
  });

  it("seg reads skip rewrite-drafts spliced from a gap", () => {
    // the transcript of s6 must show the final answers only — no "draft v1"
    const items = readTranscriptItems("s6", { tail: 50 }).items;
    const texts = items.map((i) => i.text);
    expect(texts.some((t) => t.includes("draft v1"))).toBe(false);
    expect(texts.some((t) => t.includes("final answer"))).toBe(true);
    expect(texts.some((t) => t.includes("draft chain followup"))).toBe(true);
  });
});

describe("lib/db main-chain queries", () => {
  it("seeds retained anchors inside a graft crossing the frozen watermark", () => {
    const state = emptySessionState();
    for (const v of [1, 2]) {
      const durable = readTranscriptItems("frozen-graft", { through: 4, tail: 50 });
      expect(applyViewFrame(state, {
        t: "snapshot", v, meta: emptySessionState(),
        durable: durable.items, durableTruncated: durable.truncated,
        provisional: [{ id: "live", kind: "text", role: "thought", text: "current thought", done: false, seqFrom: 3, seqTo: 3 }],
        retained: [{ id: "retained", kind: "text", role: "thought", text: "completed thought", done: true, seqFrom: 1, seqTo: 2, anchorNode: 4 }],
        durableThrough: 4,
      })).toBe("ok");
      expect(integrityBeacon(state, "frozen-graft")).toBeNull();
      expect(durable.items.map((item) => item.id)).toEqual([1, 2, 3, 4]);
      expect(renderItems(state).map((item) => item.id))
        .toEqual(["bf-1", "bf-2", "bf-3", "bf-4", "retained", "live"]);
    }
    const ended = readTranscriptItems("frozen-graft", { through: 101, tail: 50 });
    applyDurableDelta(state, ended.items); // arriving before turn-end stays fenced
    expect(state.durable?.map((item) => item.id)).toEqual(["bf-1", "bf-2", "bf-3", "bf-4"]);
    expect(applyViewFrame(state, {
      t: "patch", v: 3, prov: { order: [], upsert: [] }, durableThrough: 101,
    })).toBe("ok");
    applyDurableDelta(state, ended.items);
    expect(integrityBeacon(state, "frozen-graft")).toBeNull();
    expect(renderItems(state).map((item) => item.id))
      .toEqual(["bf-1", "bf-2", "bf-3", "bf-4", "retained", "bf-101"]);
  });

  it("bounds nested graft expansion and pages its completed history in order", () => {
    for (const [through, ids] of [
      [0, []], [2, [1, 2]], [4, [1, 2, 3, 4]],
      [11, [1, 2, 3, 4, 11]], [22, [1, 2, 3, 4, 11, 12, 21, 22]],
    ] as const) {
      const page = readTranscriptItems("nested-graft", { through });
      expect(page.items.map((i) => i.id)).toEqual(ids);
      expect(new Set(page.items.map((i) => i.messageId)).size).toBe(page.items.length);
    }
    const tail = readTranscriptItems("nested-graft", { through: 22, tail: 2 });
    expect(tail.items.map((i) => i.id)).toEqual([21, 22]);
    expect(tail.truncated).toBe(true);
    const older = readTranscriptItems("nested-graft", { before: 21, tail: 2 });
    expect(older.items.map((i) => i.id)).toEqual([11, 12]);
    expect(older.truncated).toBe(true);
    const oldest = readTranscriptItems("nested-graft", { before: 11, tail: 10 });
    expect(oldest.items.map((i) => i.id)).toEqual([1, 2, 3, 4]);
    expect(oldest.truncated).toBe(false);
  });

  it.each(["root-after-grafts", "headless-grafts"])("expands eligible nested history with no eligible current head: %s", (session) => {
    const durable = readTranscriptItems(session, { through: 22, tail: 50 });
    expect(durable.items.map((i) => i.id)).toEqual([1, 2, 3, 4, 11, 12, 21, 22]);
    expect(readTranscriptItems(session, { through: 0 }).items).toEqual([]);
    const state = emptySessionState();
    expect(applyViewFrame(state, {
      t: "snapshot", v: 1, meta: emptySessionState(),
      durable: durable.items, durableTruncated: durable.truncated, provisional: [],
      retained: [{ id: "nested-retained", kind: "text", role: "thought", text: "earlier completed thought", done: true, seqFrom: 1, seqTo: 1, anchorNode: 12 }],
      durableThrough: 22,
    })).toBe("ok");
    expect(renderItems(state).map((i) => i.id))
      .toEqual(["bf-1", "bf-2", "bf-3", "bf-4", "bf-11", "bf-12", "nested-retained", "bf-21", "bf-22"]);
    expect(integrityBeacon(state, session)).toBeNull();
  });

  it("keeps normal ancestry, explicit live branches and segment bounds", () => {
    expect(readTranscriptItems("s1", { through: 2 }).items.map((i) => i.id)).toEqual([1, 2]);
    expect(readTranscriptItems("s1", { through: 4 }).items.map((i) => i.id)).toEqual([1, 2, 3]);
    const head = branchTip("s1", 4)!;
    expect(head).toBe(4);
    expect(readTranscriptItems("s1", { head }).items.map((i) => i.id)).toEqual([1, 2, 4]);
    expect(readTranscriptItems("nested-graft", { head: 22, segBase: 12 }).items.map((i) => i.id))
      .toEqual([21, 22]);
  });

  it("omits superseded rewrite positions when the final node crosses through", () => {
    // A same-parent draft must not become durable merely because its final
    // rewrite is beyond the watermark. Re-anchored copies keep the same
    // global canonical-position rule as ordinary graft expansion.
    expect(readTranscriptItems("s6", { through: 3 }).items.map((i) => i.id)).toEqual([1]);
    expect(readTranscriptItems("s8", { through: 5 }).items.map((i) => i.id)).toEqual([4]);
    expect(readTranscriptItems("s8", { through: 101 }).items.map((i) => i.id)).toEqual([4, 101]);
  });

  it("keeps early committed rows outside the durable view snapshot", () => {
    for (const through of [0, 5]) {
      const durable = readTranscriptItems("early", { through, tail: 50 });
      expect(durable.items).toEqual([]);
      const state = emptySessionState();
      expect(applyViewFrame(state, {
        t: "snapshot", v: 1, meta: emptySessionState(),
        durable: durable.items, durableTruncated: durable.truncated,
        provisional: [{ id: "p-1-0", kind: "text", role: "thought", text: "thinking", done: false, seqFrom: 1, seqTo: 1 }],
        retained: [], durableThrough: through,
      })).toBe("ok");
      expect(renderItems(state).map((item) => item.id)).toEqual(["p-1-0"]);
      expect(state.sunkLive).toBeUndefined();
      expect(integrityBeacon(state, "early")).toBeNull();
    }
  });

  it("reads an older eligible tree when the current root is above through", () => {
    // s3 has older visible nodes 1–3 and a fresh current root at 10.
    expect(readTranscriptItems("s3", { through: 5, tail: 50 }).items.map((i) => i.id))
      .toEqual([1, 2, 3]);
  });

  it("bounds headless legacy fallback only when through is supplied", () => {
    expect(readTranscriptItems("headless", { through: 2 }).items.map((i) => i.id))
      .toEqual([1, 2]);
    expect(readTranscriptItems("headless", { through: 0 }).items).toEqual([]);
    expect(readTranscriptItems("headless").items.map((i) => i.id)).toEqual([11]);
  });

  it("mainChainHead reads sessions.main_chain_id", () => {
    const db = openSessionsDb();
    try {
      expect(mainChainHead(db, "s1")).toBe(3);
      expect(mainChainHead(db, "missing")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("mainChainRows walks the parent chain and skips fork branches", () => {
    const db = openSessionsDb();
    try {
      const rows = mainChainRows(db, "s1", 3, 100);
      expect(rows.map((r) => r.node_id)).toEqual([1, 2, 3]); // chronological, no node 4
    } finally {
      db.close();
    }
  });

  it("mainChainRows limit keeps the newest nodes", () => {
    const db = openSessionsDb();
    try {
      const rows = mainChainRows(db, "s1", 3, 2);
      expect(rows.map((r) => r.node_id)).toEqual([2, 3]);
    } finally {
      db.close();
    }
  });

  it("nodesAfter / maxNodeId drive incremental fetches", () => {
    const db = openSessionsDb();
    try {
      expect(nodesAfter(db, "s1", 1).map((r) => r.node_id)).toEqual([2, 3, 4]);
      expect(maxNodeId(db, "s1")).toBe(4);
    } finally {
      db.close();
    }
  });

  it("readTranscriptItems before-cursor pages strictly older history", () => {
    // s1 main chain: 1(user) → 2(assistant) → 3(user); node 4 is a fork off 2
    const page = readTranscriptItems("s1", { before: 3, tail: 10 });
    expect(page.items.map((i) => i.id)).toEqual([1, 2]);
    expect(page.truncated).toBe(false); // chain root reached — no more above

    const tailOnly = readTranscriptItems("s1", { before: 3, tail: 1 });
    expect(tailOnly.items.map((i) => i.id)).toEqual([2]);
    expect(tailOnly.truncated).toBe(true); // item 1 still sits above

    expect(readTranscriptItems("s1", { before: 1, tail: 10 }).items).toEqual([]);
    // a missing cursor row yields an empty page, never an error
    expect(readTranscriptItems("s1", { before: 999, tail: 10 }).items).toEqual([]);
  });

  it("compacted sessions report truncated and page across the tree boundary", () => {
    // s3's main chain starts at a fresh root (10) — the pre-compaction
    // conversation (1→2→3) is a sibling tree, not an ancestor. The audit's
    // observed symptom: truncated=false so "Load earlier" never appears and
    // the user's messages are unreachable.
    const first = readTranscriptItems("s3", {});
    expect(first.items.map((i) => i.id)).toEqual([11, 12]); // system root filtered
    expect(first.truncated).toBe(true); // earlier tree exists below

    // paging older than the first item crosses the compaction boundary to
    // the previous tree's tail
    const older = readTranscriptItems("s3", { before: 11, tail: 10 });
    expect(older.items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(older.truncated).toBe(false); // node 1 is the session's oldest
  });

  it("before-cursor at a tree root jumps to the previous tree", () => {
    // cursor IS the new root (system row, filtered from items — the client
    // can still land here via a mid-walk cursor)
    const page = readTranscriptItems("s3", { before: 10, tail: 10 });
    expect(page.items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(page.truncated).toBe(false);
  });

  it("grafted compactions splice the dead branch into the chain", () => {
    // s4's main chain jumps 3 → 100; the original continuation 4→5 sits in
    // the gap — the reported "previous task's output vanished" symptom
    const first = readTranscriptItems("s4", {});
    expect(first.items.map((i) => i.id)).toEqual([4, 5, 101, 102]);
    expect(first.truncated).toBe(false); // dead branch included — nothing older renders
  });

  it("load-earlier from a post-graft item reaches the dead branch", () => {
    const page = readTranscriptItems("s4", { before: 101, tail: 10 });
    expect(page.items.map((i) => i.id)).toEqual([4, 5]);
    expect(page.truncated).toBe(false); // 1–3 are filtered system rows
  });

  it("a graft-child cursor pages its gap's dead tip, not its parent", () => {
    // a renderable graft child: 101's parent 100 is a system row — nodes
    // 4–99 between them are dead history that must page BEFORE the base
    const page = readTranscriptItems("s4", { before: 100, tail: 10 });
    expect(page.items.map((i) => i.id)).toEqual([4, 5]);
  });

  it("drops a dead row whose message_id was re-anchored onto the chain", () => {
    // s8: node 5 (dead branch, mid g4) vs node 101 (chain, mid g4, different
    // parent): both positions share an identity and must not render twice.
    const page = readTranscriptItems("s8", {});
    const texts = page.items.map((i) => i.text);
    expect(texts).toContain("final output");
    expect(texts).not.toContain("stale draft output");
    expect(texts).toContain("old task prompt"); // dead-unique rows still splice
    expect(page.items.filter((i) => i.messageId === "g4")).toHaveLength(1);
  });

  it("segments exclude re-anchored dead rows", () => {
    const { segments } = sessionSegments("s8");
    // dead splice contributes only node 4 — merged into the base run
    const old = segments.find((s) => !s.isMain);
    expect(old?.tip).toBe(4);
    expect(old?.count).toBe(4); // nodes 1–4; re-anchored 5 excluded
    const cur = segments.find((s) => s.isMain);
    expect(cur?.tip).toBe(102);
  });

  it("readTranscriptDelta serves incremental polls without the fork branch", () => {
    // s1 main chain 1→2→3; node 4 is a fork off 2 — the ?after= path must
    // only surface main-chain rows
    const d = readTranscriptDelta("s1", 1);
    expect(d.reset).toBe(false);
    expect(d.items.map((i) => i.id)).toEqual([2, 3]);
    // cursor at the tip → empty delta, no reset
    const tip = readTranscriptDelta("s1", 3);
    expect(tip.reset).toBe(false);
    expect(tip.items).toEqual([]);
  });

  it("readTranscriptDelta resets stale or off-chain cursors", () => {
    expect(readTranscriptDelta("s1", 4).reset).toBe(true); // fork remnant
    expect(readTranscriptDelta("s1", 99).reset).toBe(true); // beyond the chain
    expect(readTranscriptDelta("s1", 0).reset).toBe(true); // below the floor
  });

  it("readTranscriptItems seg= bounds the read to (base, tip]", () => {
    // s4 post-compaction segment: base=5 (dead-branch tip) — only the
    // grafted continuation's renderable rows, no shared base, no dead rows
    const r = readTranscriptItems("s4", { head: 102, segBase: 5 });
    expect(r.items.map((i) => i.id)).toEqual([101, 102]);
    // the pre-compaction segment reads the dead branch + its base context
    const prev = readTranscriptItems("s4", { head: 5, segBase: 0 });
    expect(prev.items.map((i) => i.id)).toEqual([4, 5]);
  });

  it("sessionActivity returns the newest node time per session", () => {
    const db = openSessionsDb();
    try {
      const act = sessionActivity(db);
      expect(act.get("s1")).toBe(4); // node 4 (fork branch) is the newest
      expect(act.get("s2")).toBe(5);
      expect(act.has("missing")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("sessionActivity rides the UNIQUE(session_id,node_id) covering index", () => {
    const db = openSessionsDb();
    try {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${SESSION_ACTIVITY_SQL}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(" | ");
      expect(plan).toMatch(/COVERING INDEX/);
    } finally {
      db.close();
    }
  });
});

describe("searchIndex (FTS5 incremental)", () => {
  it("indexes message text and finds it via MATCH", () => {
    indexNewRows();
    const hits = searchFts("needle")!;
    expect(hits).not.toBeNull();
    const ids = new Set(hits.map((h) => `${h.sessionId}:${h.nodeId}`));
    expect(ids.has("s1:1")).toBe(true);
    expect(ids.has("s1:4")).toBe(true); // fork nodes are indexed too — search is global
    expect(ids.has("s2:1")).toBe(true); // hidden filtering happens in the route
    expect(hits.every((h) => h.text.includes("needle"))).toBe(true);
  });

  it("incremental indexing picks up newly appended rows only", () => {
    const db = new DatabaseSync(join(cliDir, "sessions.db"));
    db.prepare(
      "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
    ).run("s1", 5, 3, msg("assistant", "fresh obelisk token", "m5"), 6);
    db.close();
    indexNewRows();
    const hits = searchFts("obelisk")!;
    expect(hits.map((h) => h.nodeId)).toEqual([5]);
  });

  it("sanitizes MATCH input — quotes and operators can't break the query", () => {
    expect(searchFts('needle " OR session_id:s1')).not.toBeNull();
    expect(searchFts('")')).not.toBeNull();
  });

  it("sessionMeta exposes title/cwd/hidden for filtering", () => {
    const meta = sessionMeta(["s1", "s2", "nope"]);
    expect(meta.get("s1")).toMatchObject({ title: "Session One", hidden: false });
    expect(meta.get("s2")).toMatchObject({ hidden: true });
    expect(meta.has("nope")).toBe(false);
  });
});

describe("trigram search (round 2)", () => {
  it("matches word fragments and Korean words with particles", () => {
    const db = new DatabaseSync(join(cliDir, "sessions.db"));
    db.prepare(
      "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
    ).run("s1", 6, 5, msg("assistant", "트랜스크립트를 확인했다 worktree", "m6"), 7);
    db.close();
    indexNewRows();
    for (const q of ["트랜스크립", "크립트", "worktre", "WORKTREE"]) {
      expect(searchFts(q)!.map((h) => h.nodeId)).toContain(6);
    }
  });

  it("ftsCanServe sends short terms to the substring scan", () => {
    expect(ftsCanServe("리팩터")).toBe(true);
    expect(ftsCanServe("worktree status")).toBe(true);
    expect(ftsCanServe("버그")).toBe(false);
    expect(ftsCanServe("버그 수정하기")).toBe(false);
    expect(ftsCanServe("   ")).toBe(false);
  });

  it("searchLike scans the extracted-text column for short terms", () => {
    // "rk" is 2 chars — under the trigram floor; the LIKE path over
    // messages_fts.text must still find the worktree row
    const hits = searchLike("rk")!;
    expect(hits).not.toBeNull();
    expect(hits.map((h) => h.nodeId)).toContain(6);
    // LIKE metachars are escaped — a % inside the term can't wildcard-match
    expect(searchLike("zzz%zzz")!.length).toBe(0);
    expect(searchLike("크립")!.map((h) => h.nodeId)).toContain(6);
  });

  it("ensureFtsSchema replaces a unicode61 index and resets the cursor", () => {
    const mem = new DatabaseSync(":memory:");
    mem.exec(
      "CREATE VIRTUAL TABLE messages_fts USING fts5(text, session_id UNINDEXED, node_id UNINDEXED, src_row UNINDEXED)",
    );
    mem.exec("CREATE TABLE meta(k TEXT PRIMARY KEY, v INTEGER)");
    mem.exec("INSERT INTO meta VALUES ('last_row_id', 42)");
    ensureFtsSchema(mem);
    const row = mem.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_fts'").get() as {
      sql: string;
    };
    expect(row.sql).toMatch(/trigram/);
    expect(mem.prepare("SELECT COUNT(*) AS n FROM meta").get()).toMatchObject({ n: 0 });
    ensureFtsSchema(mem); // idempotent once migrated
    mem.close();
  });

  it("tokenizer rebuild wipes stale fts_rowid refs but keeps usage cursor", () => {
    const mem = new DatabaseSync(":memory:");
    mem.exec(
      "CREATE VIRTUAL TABLE messages_fts USING fts5(text, session_id UNINDEXED, node_id UNINDEXED, src_row UNINDEXED)",
    );
    mem.exec("CREATE TABLE meta(k TEXT PRIMARY KEY, v INTEGER)");
    mem.exec(
      "CREATE TABLE indexed_nodes(session_id TEXT, node_id INTEGER, src_row INTEGER, fts_rowid INTEGER, PRIMARY KEY(session_id,node_id))",
    );
    mem.exec("INSERT INTO meta VALUES ('last_row_id', 42), ('usage_row_id', 99), ('aux_v', 2), ('indexed_sessions_v', 1)");
    mem.exec("INSERT INTO indexed_nodes VALUES ('s1', 1, 1, 7)");
    ensureFtsSchema(mem);
    const keys = new Set((mem.prepare("SELECT k FROM meta").all() as { k: string }[]).map((r) => r.k));
    // fts was dropped → text cursor + roster seed + stale fts_rowids die…
    expect(keys.has("last_row_id")).toBe(false);
    expect(keys.has("indexed_sessions_v")).toBe(false);
    expect(mem.prepare("SELECT COUNT(*) AS n FROM indexed_nodes").get()).toMatchObject({ n: 0 });
    // …but the usage index is keyed on (session,node), unaffected by the
    // fts rebuild — its cursor and the schema version stay
    expect(keys.has("usage_row_id")).toBe(true);
    expect(keys.has("aux_v")).toBe(true);
    mem.close();
  });
});

describe("index GC (M2)", () => {
  it("drops rows of sessions deleted from sessions.db", () => {
    const w = new DatabaseSync(join(cliDir, "sessions.db"));
    w.prepare(
      "INSERT INTO sessions(id,working_directory,backend_type,model,agent_mode,created_at,last_activity_at,title,main_chain_id,hidden) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("s9", "/tmp/nine", "local", "m", "default", 1, 1, "Doomed", 1, 0);
    w.prepare(
      "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
    ).run("s9", 1, null, msg("user", "zeppelin cargo manifest", "z1"), 9);
    w.close();
    indexNewRows();
    expect(searchFts("zeppelin")!.map((h) => h.sessionId)).toEqual(["s9"]);

    const w2 = new DatabaseSync(join(cliDir, "sessions.db"));
    w2.prepare("DELETE FROM message_nodes WHERE session_id = 's9'").run();
    w2.prepare("DELETE FROM sessions WHERE id = 's9'").run();
    w2.close();
    runMaintenance(true);

    expect(searchFts("zeppelin")).toEqual([]);
  });

  it("never ATTACHes sessions.db — ATTACH inherits the fts connection's read-write mode", () => {
    expect(readFileSync(join(process.cwd(), "lib/searchIndex.ts"), "utf8")).not.toMatch(/\bATTACH\b/);
  });
});

describe("search project filter (L5)", () => {
  it("matches the project directory exactly", () => {
    const w = new DatabaseSync(join(cliDir, "sessions.db"));
    w.prepare(
      "INSERT INTO sessions(id,working_directory,backend_type,model,agent_mode,created_at,last_activity_at,title,main_chain_id,hidden) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("s7", "/tmp/one-e2e", "local", "m", "default", 1, 1, "Sibling", null, 0);
    w.close();
    const db = openSessionsDb();
    try {
      expect(projectSessionIds(db, "/tmp/one")).toEqual(["s1"]);
    } finally {
      db.close();
    }
  });

  it("an empty session list matches nothing — not everything", () => {
    expect(searchFts("needle", 400, { sessionIds: [], includeTools: true })).toEqual([]);
    expect(searchLike("ne", 400, { sessionIds: [], includeTools: true })).toEqual([]);
  });
});

describe("index text (uncapped)", () => {
  it("indexes the whole message — the tail beyond 4KB is searchable", () => {
    const w = new DatabaseSync(join(cliDir, "sessions.db"));
    w.prepare(
      "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
    ).run("s1", 7, 6, msg("assistant", "headcap " + "m".repeat(5000) + " tailcap", "m7"), 9);
    w.close();
    indexNewRows();
    expect(searchFts("headcap")!.map((h) => h.nodeId)).toEqual([7]);
    // recall over disk: the tail IS indexed (FTS_TEXT_CAP removed)
    expect(searchFts("tailcap")!.map((h) => h.nodeId)).toEqual([7]);
  });
});

describe("index rewrite dedup", () => {
  // the CLI rewrites a node under a NEW row_id (sessions.db's stable key is
  // UNIQUE(session_id,node_id), row_id churns) — the index must replace the
  // old copy, not stack duplicates that eat each session's 3-snippet slots
  it("a rewritten node replaces the old fts entry", () => {
    const w = new DatabaseSync(join(cliDir, "sessions.db"));
    w.prepare("DELETE FROM message_nodes WHERE session_id='s1' AND node_id=6").run();
    w.prepare(
      "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
    ).run("s1", 6, 5, msg("assistant", "quixotic rewritten text", "m6b"), 8);
    w.close();
    indexNewRows();
    expect(searchFts("quixotic")!.map((h) => h.nodeId)).toEqual([6]);
    // the old text's copy is gone — not just shadowed
    expect(searchFts("트랜스크립트")).toEqual([]);
    expect(searchLike("quix")).toHaveLength(1);
  });
});

describe("bounded main-chain traversal", () => {
  it("visits only the requested nodes, including for id-only queries", async () => {
    const { chainNodeIds } = await import("../lib/db");
    const db = new DatabaseSync(":memory:");
    let visits = 0;
    db.function("observe_parent", (p) => {
      if (p !== null && typeof p !== "number") throw new TypeError("parent node must be numeric or null");
      visits++;
      return p;
    });
    try {
      db.exec(`CREATE TABLE nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER,
        chat_message TEXT, created_at INTEGER, UNIQUE(session_id,node_id));
        CREATE VIEW message_nodes AS SELECT session_id,node_id,observe_parent(parent_node_id) AS parent_node_id,
        chat_message,created_at FROM nodes`);
      const ins = db.prepare("INSERT INTO nodes VALUES(?,?,?,?,?)");
      for (let n = 1; n <= 2000; n++) ins.run("s", n, n === 1 ? null : n - 1, "{}", 1);
      expect(mainChainRows(db, "s", 2000, 2).map((r) => r.node_id)).toEqual([1999, 2000]);
      expect(visits).toBe(2);
      visits = 0;
      expect(chainNodeIds(db, "s", 2000, 2)).toEqual([2000, 1999]);
      expect(visits).toBe(2);
      visits = 0;
      expect(mainChainRows(db, "s", 2000, 0)).toEqual([]);
      expect(chainNodeIds(db, "s", 2000, 0)).toEqual([]);
      expect(visits).toBe(0);
      // Corrupt parent cycles must also stop at the depth budget.
      db.prepare("UPDATE nodes SET parent_node_id=2000 WHERE node_id=1999").run();
      expect(chainNodeIds(db, "s", 2000, 3)).toEqual([2000, 1999, 2000]);
    } finally { db.close(); }
  });
});
