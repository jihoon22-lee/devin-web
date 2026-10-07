import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic corpus — env must be set before lib/* modules are imported.
const cliDir = mkdtempSync(join(tmpdir(), "dw-cli-tree-"));
const stateDir = mkdtempSync(join(tmpdir(), "dw-state-tree-"));
process.env.DEVIN_CLI_DIR = cliDir;
process.env.DEVIN_WEB_STATE_DIR = stateDir;

const { DatabaseSync } = await import("node:sqlite");
const SDB = join(cliDir, "sessions.db");

const msg = (role: string, text: string, mid: string, meta?: Record<string, unknown>) =>
  JSON.stringify({
    message_id: mid,
    role,
    content: [{ type: "text", text }],
    ...(meta ? { metadata: meta } : {}),
  });

const sdb = new DatabaseSync(SDB);
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

// t1 — a live fork inside one tree: main 1→2→3, node 4 branches off 2
insS.run("t1", "/tmp/t1", "local", "m", "default", 1, 1, "Tree One", 3, 0);
insN.run("t1", 1, null, msg("user", "first question", "a1"), 1);
insN.run("t1", 2, 1, msg("assistant", "first answer", "a2"), 2);
insN.run("t1", 3, 2, msg("user", "main followup", "a3"), 3);
insN.run("t1", 4, 2, msg("assistant", "fork branch answer", "a4"), 4);

// t2 — compacted: old tree 1→2→3 orphaned, new root 10→11→12
insS.run("t2", "/tmp/t2", "local", "m", "default", 1, 1, "Compacted", 12, 0);
insN.run("t2", 1, null, msg("user", "before compress", "b1"), 1);
insN.run("t2", 2, 1, msg("assistant", "old reply", "b2"), 2);
insN.run("t2", 3, 2, msg("user", "old tail", "b3"), 3);
insN.run("t2", 10, null, msg("user", "summary payload", "c0", { is_user_input: null }), 4);
insN.run("t2", 11, 10, msg("assistant", "post-compress reply", "c1"), 5);
insN.run("t2", 12, 11, msg("user", "new question", "c2"), 6);

// t3 — deeper branch: 1→2, children 3 and 5 off 2; 5→6; then root 20→21
insS.run("t3", "/tmp/t3", "local", "m", "default", 1, 1, "Deep", 21, 0);
insN.run("t3", 1, null, msg("user", "root q", "d1"), 1);
insN.run("t3", 2, 1, msg("assistant", "root a", "d2"), 2);
insN.run("t3", 3, 2, msg("user", "main child", "d3"), 3);
insN.run("t3", 5, 2, msg("assistant", "side child", "d5"), 4);
insN.run("t3", 6, 5, msg("user", "deeper leaf", "d6"), 5);
insN.run("t3", 20, null, msg("user", "tree two q", "e1"), 6);
insN.run("t3", 21, 20, msg("assistant", "tree two a", "e2"), 7);
sdb.close();

const { catchupTreeSession, treeSummary, branchTip } = await import("../lib/treeIndex");
const { readTranscriptItems } = await import("../lib/transcript-db");

describe("treeIndex incremental cache", () => {
  it("builds tree summaries from a fork + compaction corpus", () => {
    expect(catchupTreeSession("t1").done).toBe(true);
    const s = treeSummary("t1");
    expect(s.trees).toHaveLength(1);
    expect(s.trees[0]).toMatchObject({ rootNodeId: 1, isMain: true, count: 4, headNodeId: 3 });
    expect(s.trees[0].preview).toContain("first question");
    expect(s.branches).toHaveLength(1);
    expect(s.branches[0].parentNodeId).toBe(2);
    expect(s.branches[0].children.map((c) => c.nodeId)).toEqual([3, 4]);
    expect(s.branches[0].children[1].snippet).toContain("fork branch answer");
  });

  it("reports every root of a compacted session with the main tree flagged", () => {
    const s = treeSummary("t2");
    expect(s.trees).toHaveLength(2);
    const [oldTree, newTree] = s.trees;
    expect(oldTree).toMatchObject({ rootNodeId: 1, count: 3, headNodeId: 3, isMain: false });
    expect(oldTree.preview).toContain("before compress");
    expect(newTree).toMatchObject({ rootNodeId: 10, count: 3, headNodeId: 12, isMain: true });
    // root 10 is an internal summary node (is_user_input falsy) — preview
    // must fall through to the first real user message of the new tree
    expect(newTree.preview).toContain("new question");
  });

  it("resolves deeper subtree tips for branch navigation", () => {
    catchupTreeSession("t3");
    const s = treeSummary("t3");
    expect(s.trees.map((t) => t.rootNodeId)).toEqual([1, 20]);
    expect(s.trees[1]).toMatchObject({ isMain: true, headNodeId: 21 });
    expect(branchTip("t3", 5)).toBe(6); // deepest node under the side child
    expect(branchTip("t3", 3)).toBe(3); // leaf maps to itself
    expect(branchTip("t3", 999)).toBeNull();
  });

  it("incremental catch-up sees appended nodes and new branch points", () => {
    const w = new DatabaseSync(SDB);
    w.prepare(
      "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
    ).run("t1", 5, 2, msg("assistant", "third child branch", "a5"), 9);
    w.close();
    catchupTreeSession("t1");
    const s = treeSummary("t1");
    expect(s.trees[0].count).toBe(5);
    expect(s.branches[0].children.map((c) => c.nodeId)).toEqual([3, 4, 5]);
  });

  it("a node rewrite under a new row_id reparents without stacking", () => {
    const w = new DatabaseSync(SDB);
    // CLI rewrite: same (session,node), new row_id, new parent — node 5
    // moves from 2 onto 3, collapsing the branch at 2 back to one child
    w.prepare("DELETE FROM message_nodes WHERE session_id='t1' AND node_id=5").run();
    w.prepare(
      "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
    ).run("t1", 5, 3, msg("assistant", "reparented answer", "a5b"), 10);
    w.close();
    catchupTreeSession("t1");
    const s = treeSummary("t1");
    expect(s.trees[0].count).toBe(5); // no duplicate node 5
    // parent 2 keeps its real fork (3,4); the reparent landed — node 5 now
    // hangs under node 3, which makes 3's subtree tip 5
    expect(s.branches[0].children.map((c) => c.nodeId)).toEqual([3, 4]);
    expect(branchTip("t1", 3)).toBe(5);
  });

  it("a deleted session's cache is dropped instead of served stale", () => {
    const w = new DatabaseSync(SDB);
    w.prepare("INSERT INTO sessions VALUES ('gone','/tmp/g','local','m','default',1,1,'G',1,0)").run();
    w.prepare(
      "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
    ).run("gone", 1, null, msg("user", "doomed", "g1"), 20);
    w.close();
    expect(treeSummary("gone").trees).toHaveLength(1);
    const w2 = new DatabaseSync(SDB);
    w2.prepare("DELETE FROM message_nodes WHERE session_id='gone'").run();
    w2.prepare("DELETE FROM sessions WHERE id='gone'").run();
    w2.close();
    expect(treeSummary("gone").trees).toHaveLength(0);
  });
});

describe("transcript head/branch reads", () => {
  it("head=<nodeId> walks the branch's own ancestry, not the main chain", () => {
    // t1 node 4 is the fork child of 2 — its ancestry is 1→2→4, never 3
    const page = readTranscriptItems("t1", { head: 4 });
    expect(page.items.map((i) => i.id)).toEqual([1, 2, 4]);
  });

  it("head into an orphaned pre-compaction tree renders it", () => {
    const page = readTranscriptItems("t2", { head: 3 });
    expect(page.items.map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it("a missing head yields an empty page, not an error", () => {
    expect(readTranscriptItems("t1", { head: 999 }).items).toEqual([]);
    expect(readTranscriptItems("missing", { head: 1 }).items).toEqual([]);
  });
});
