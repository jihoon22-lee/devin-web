import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/db resolves DEVIN_CLI_DIR at module load — set before dynamic import
const cliDir = mkdtempSync(join(tmpdir(), "dw-usage-cli-"));
process.env.DEVIN_CLI_DIR = cliDir;
// lib/usage now reads the search.db cache (lib/searchIndex) — point it at a
// temp state dir BEFORE the dynamic import, or fixtures land in the real one
const stateDir = mkdtempSync(join(tmpdir(), "dw-usage-state-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;

const { DatabaseSync } = await import("node:sqlite");

const now = Math.floor(Date.now() / 1000);

const sdb = new DatabaseSync(join(cliDir, "sessions.db"));
sdb.exec(`CREATE TABLE sessions(
  id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
  model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT)`);
sdb.exec(`CREATE TABLE message_nodes(
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id))`);

const insS = sdb.prepare(
  "INSERT INTO sessions(id,working_directory,backend_type,model,agent_mode,created_at,last_activity_at,title,main_chain_id,hidden,metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
);
const insN = sdb.prepare(
  "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
);

const assistant = (mid: string, m: Record<string, number>) =>
  JSON.stringify({
    message_id: mid,
    role: "assistant",
    content: [],
    metadata: { num_tokens: m.output_tokens ?? null, metrics: m },
  });

insS.run("s1", "/tmp/one", "local", "m", "default", 1, now, "One", 3, 0, JSON.stringify({ total_credit_cost: 0.25, total_acu_cost: 1.5 }));
insN.run("s1", 1, null, JSON.stringify({ message_id: "u1", role: "user", content: "hi", metadata: { is_user_input: true } }), now - 10);
insN.run("s1", 2, 1, assistant("a1", { input_tokens: 100, output_tokens: 10, cache_read_tokens: 50 }), now - 9);
insN.run("s1", 3, 2, assistant("a2", { input_tokens: 200, output_tokens: 20, cache_read_tokens: 60, cache_creation_tokens: 5 }), now - 8);
// s2: hidden — must not appear in the report (metric-less message keeps
// the daily series expectations exact)
insS.run("s2", "/tmp/two", "local", "m", "default", 1, now, "Hidden", 1, 1, null);
insN.run("s2", 1, null, JSON.stringify({ message_id: "h1", role: "user", content: "x" }), now);
// s3: no metrics at all — still listed (zero usage)
insS.run("s3", "/tmp/three", "local", "m", "default", 1, now, "Empty", null, 0, null);
sdb.close();

const { usageReport, resetUsageCache } = await import("../lib/usage");

describe("lib/usage", () => {
  it("aggregates per-session tokens and cost, skips hidden", () => {
    resetUsageCache();
    const r = usageReport();
    const s1 = r.sessions.find((s) => s.sessionId === "s1");
    expect(s1).toMatchObject({
      responses: 2,
      inputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 110,
      cacheCreateTokens: 5,
      costAcu: 1.5,
      costCredit: 0.25,
      title: "One",
    });
    expect(s1?.lastActivity).toBe(now - 8);
    // hidden session excluded; zero-usage session still listed
    expect(r.sessions.find((s) => s.sessionId === "s2")).toBeUndefined();
    expect(r.sessions.find((s) => s.sessionId === "s3")).toMatchObject({ responses: 0, outputTokens: 0 });
    expect(r.totals).toMatchObject({
      sessions: 2, // s1 + s3
      responses: 2,
      inputTokens: 300,
      outputTokens: 30,
      costAcu: 1.5,
    });
  });

  it("builds a daily series over the last 30 days", () => {
    const r = usageReport();
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const todayRow = r.daily.find((x) => x.day === today);
    expect(todayRow).toMatchObject({ inputTokens: 300, outputTokens: 30 });
  });

  it("serves from the incremental index and tops up rows appended later", () => {
    resetUsageCache();
    expect(usageReport().progress.complete).toBe(true);
    const w = new DatabaseSync(join(cliDir, "sessions.db"));
    w.prepare(
      "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
    ).run("s1", 4, 3, assistant("a3", { input_tokens: 1000, output_tokens: 100 }), now - 1);
    w.close();
    resetUsageCache();
    expect(usageReport().sessions.find((s) => s.sessionId === "s1")).toMatchObject({
      responses: 3,
      inputTokens: 1300,
      outputTokens: 130,
    });
  });

  it("usageSeries returns one session's responses oldest → newest", async () => {
    const { usageSeries } = await import("../lib/searchIndex");
    expect(usageSeries("s1").map((p) => p.outputTokens)).toEqual([10, 20, 100]);
  });

  // the CLI rewrites a message under a NEW row_id (same session_id+node_id —
  // the source's UNIQUE key). The usage cache keyed on src_row used to keep
  // both copies, inflating totals ~9% on the real corpus.
  it("a message rewritten with a new row_id is counted once", () => {
    const w = new DatabaseSync(join(cliDir, "sessions.db"));
    w.prepare("DELETE FROM message_nodes WHERE session_id='s1' AND node_id=4").run();
    w.prepare(
      "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
    ).run("s1", 4, 3, assistant("a3", { input_tokens: 1000, output_tokens: 100 }), now - 1);
    w.close();
    resetUsageCache();
    expect(usageReport().sessions.find((s) => s.sessionId === "s1")).toMatchObject({
      responses: 3,
      inputTokens: 1300,
      outputTokens: 130,
    });
  });

  it("a rewrite that drops metrics removes the stale usage row", () => {
    const w = new DatabaseSync(join(cliDir, "sessions.db"));
    w.prepare("DELETE FROM message_nodes WHERE session_id='s1' AND node_id=4").run();
    w.prepare(
      "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
    ).run("s1", 4, 3, JSON.stringify({ message_id: "a3", role: "assistant", content: [], metadata: {} }), now - 1);
    w.close();
    resetUsageCache();
    expect(usageReport().sessions.find((s) => s.sessionId === "s1")).toMatchObject({
      responses: 2,
      inputTokens: 300,
      outputTokens: 30,
    });
  });

  it("never scans chat_message JSON at report time (the 4.6s event-loop stall)", () => {
    expect(readFileSync(join(process.cwd(), "lib/usage.ts"), "utf8")).not.toMatch(/json_extract/);
  });
});
