import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// hermetic sessions.db — env must be set before lib/db reads it at import
const cliDir = mkdtempSync(join(tmpdir(), "dw-items-cli-"));
const stateDir = mkdtempSync(join(tmpdir(), "dw-items-state-"));
process.env.DEVIN_CLI_DIR = cliDir;
process.env.DEVIN_WEB_STATE_DIR = stateDir;
afterAll(() => {
  rmSync(cliDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

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
// nodes 1-2 = last completed turn (durable); nodes 3-4 = committed mid-turn
// rows of the RUNNING turn — the provisional region owns them, durable must
// stop at the watermark (2)
sdb.prepare(
  "INSERT INTO sessions(id,working_directory,backend_type,model,agent_mode,created_at,last_activity_at,title,main_chain_id,hidden) VALUES (?,?,?,?,?,?,?,?,?,?)",
).run("sid", "/tmp/x", "local", "m", "default", 1, 1, "S", 4, 0);
const insN = sdb.prepare(
  "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
);
insN.run("sid", 1, null, msg("user", "earlier question", "m1"), 1);
insN.run("sid", 2, 1, msg("assistant", "earlier answer", "m2"), 2);
insN.run("sid", 3, 2, msg("user", "running prompt", "m3"), 3);
insN.run("sid", 4, 3, msg("assistant", "running answer", "m4"), 4);
// sid2: only nodes 1-2 exist at adoption time — the running turn's rows
// (3-4) are inserted later, inside the test, to simulate mid-turn commits
sdb.prepare(
  "INSERT INTO sessions(id,working_directory,backend_type,model,agent_mode,created_at,last_activity_at,title,main_chain_id,hidden) VALUES (?,?,?,?,?,?,?,?,?,?)",
).run("sid2", "/tmp/x", "local", "m", "default", 1, 1, "S2", 2, 0);
insN.run("sid2", 1, null, msg("user", "earlier question", "p1"), 1);
insN.run("sid2", 2, 1, msg("assistant", "earlier answer", "p2"), 2);

const { manager } = await import("../lib/state");
const { ItemAssembler } = await import("../lib/acp/itemAssembler");
const { GET } = await import("../app/api/sessions/[id]/items/route");

const get = (id: string, q = "") =>
  GET(new Request(`http://x/api/sessions/${id}/items${q}`), {
    params: Promise.resolve({ id }),
  }).then((r) => r.json());

describe("GET /api/sessions/:id/items — two-region snapshot", () => {
  it("separates durable rows from the running turn's provisional region", async () => {
    const m = manager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    const asm = new ItemAssembler("t1");
    asm.push({
      seq: 1,
      type: "session_update",
      data: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "running answer" },
      },
    });
    // watermark frozen at the turn's start — mid-turn commits 3-4 sit above it
    mi.regions.prov.set("sid", { asm, turnStartNode: 2, ended: false });

    const r = await get("sid", "?tail=50");
    expect(r.durableThrough).toBe(2);
    expect(r.durable.map((i: { id?: number }) => i.id)).toEqual([1, 2]);
    expect(r.provisional.map((i: { text?: string }) => i.text)).toEqual(["running answer"]);
    // no text may appear in both regions
    const dtexts = new Set(r.durable.map((i: { text?: string }) => i.text));
    for (const p of r.provisional as { text?: string }[]) {
      expect(dtexts.has(p.text)).toBe(false);
    }
    mi.regions.prov.delete("sid");
  });

  it("an adopted running turn's mid-turn commits stay out of durable", async () => {
    const m = manager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    // drive the real adopt path: daemon-socket mode + shim_state busy
    const origEnsure = mi.ensure;
    const origReq = mi.bridge.request;
    const origProc = mi.bridge.proc;
    mi.ensure = async () => ({});
    mi.bridge.proc = { pid: -1 };
    mi.bridge.request = async (method: string) =>
      method === "_devin-web/shim_state"
        ? { gen: 1, sessions: [{ sessionId: "sid2", cwd: "/tmp/x", loadResult: null, busy: true }] }
        : {};
    try {
      await m.loadSession("sid2", "/tmp/x"); // adopt — db tip is 2 here
      // the running turn commits more rows before its first content update
      // streams in — they must not leak into the durable region (sunkLive)
      insN.run("sid2", 3, 2, msg("user", "mid-turn q", "p3"), 3);
      insN.run("sid2", 4, 3, msg("assistant", "mid-turn a", "p4"), 4);
      const r = await get("sid2", "?tail=50");
      expect(r.durableThrough).toBe(2);
      expect(r.durable.map((i: { id?: number }) => i.id)).toEqual([1, 2]);
      expect(r.provisional).toEqual([]);
    } finally {
      mi.ensure = origEnsure;
      mi.bridge.request = origReq;
      mi.bridge.proc = origProc;
      mi.sessions.delete("sid2");
      mi.regions.prov.delete("sid2");
      mi.regions.provRestored.delete("sid2");
      mi.maxNodeCache.delete("sid2");
    }
  });

  it("with no turn running, durableThrough is the db tip and all rows are durable", async () => {
    const r = await get("sid");
    expect(r.durableThrough).toBe(4);
    expect(r.provisional).toEqual([]);
    expect(r.durable.map((i: { id?: number }) => i.id)).toEqual([1, 2, 3, 4]);
  });

  it("carries retained items alongside the two regions", async () => {
    const m = manager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    mi.regions.retainedBy.set("sid", [
      {
        id: "p-t-0", kind: "text", role: "thought", text: "was thinking",
        done: true, seqFrom: 1, seqTo: 2, anchorNode: 2,
      },
    ]);
    mi.regions.retainedRestored.add("sid"); // the itemlog lazy-load is covered elsewhere
    try {
      const r = await get("sid", "?tail=50");
      expect(r.retained).toEqual([
        expect.objectContaining({ id: "p-t-0", role: "thought", anchorNode: 2 }),
      ]);
    } finally {
      mi.regions.retainedBy.delete("sid");
      mi.regions.retainedRestored.delete("sid");
    }
  });
});
