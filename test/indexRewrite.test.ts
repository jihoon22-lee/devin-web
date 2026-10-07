import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic dirs — lib/searchIndex reads both env vars at import time.
const cliDir = mkdtempSync(join(tmpdir(), "dw-rewrite-cli-"));
const stateDir = mkdtempSync(join(tmpdir(), "dw-rewrite-state-"));
process.env.DEVIN_CLI_DIR = cliDir;
process.env.DEVIN_WEB_STATE_DIR = stateDir;

const { DatabaseSync } = await import("node:sqlite");

const assistant = (mid: string, input: number, output: number) =>
  JSON.stringify({
    message_id: mid,
    role: "assistant",
    content: [{ type: "text", text: `reply ${mid}` }],
    metadata: { metrics: { input_tokens: input, output_tokens: output } },
  });

function buildSessionsDb() {
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
  sdb
    .prepare(
      "INSERT INTO sessions(id,working_directory,backend_type,model,agent_mode,created_at,last_activity_at,title,main_chain_id,hidden) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .run("s1", "/tmp/one", "local", "m", "default", 1, 1, "One", 5, 0);
  const insN = sdb.prepare(
    "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
  );
  insN.run("s1", 1, null, assistant("a1", 10, 1), 100);
  // node 3 carries a >4KB text so its capped index copy can be restored
  const longText = "longhead " + "z".repeat(5000) + " longtail";
  for (let n = 2; n <= 5; n++) {
    insN.run(
      "s1", n, n - 1,
      n === 3
        ? JSON.stringify({ message_id: "a3", role: "assistant", content: [{ type: "text", text: longText }], metadata: { metrics: { input_tokens: 1, output_tokens: 1 } } })
        : assistant(`a${n}`, 1, 1),
      100 + n,
    );
  }
  sdb.close();
}
buildSessionsDb();

// Pre-seed an OLD-schema search.db: usage_rows keyed on src_row with the same
// (session,node) twice — exactly what the live cache accumulated (~1,385 dup
// pairs) — plus a duplicated fts row pair.
{
  const f = new DatabaseSync(join(stateDir, "search.db"));
  f.exec("CREATE TABLE meta(k TEXT PRIMARY KEY, v INTEGER)");
  f.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(
    text, session_id UNINDEXED, node_id UNINDEXED, src_row UNINDEXED,
    role UNINDEXED, created_at UNINDEXED, tokenize = 'trigram')`);
  f.exec(`CREATE TABLE usage_rows(
    src_row INTEGER PRIMARY KEY, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL, cache_create_tokens INTEGER NOT NULL)`);
  f.prepare("INSERT INTO usage_rows VALUES (?,?,?,?,?,?,?,?)").run(1, "s1", 1, 100, 10, 1, 0, 0);
  f.prepare("INSERT INTO usage_rows VALUES (?,?,?,?,?,?,?,?)").run(5, "s1", 1, 100, 10, 1, 0, 0); // stale rewrite copy
  f.prepare("INSERT INTO messages_fts(text,session_id,node_id,src_row,role,created_at) VALUES (?,?,?,?,?,?)")
    .run("alpha old draft", "s1", 1, 1, "assistant", 100);
  f.prepare("INSERT INTO messages_fts(text,session_id,node_id,src_row,role,created_at) VALUES (?,?,?,?,?,?)")
    .run("alpha final", "s1", 1, 5, "assistant", 100);
  // one CAPPED row (the 4KB prefix of node 3's source text) — aux_v4 must
  // restore the full text from sessions.db, in place
  f.prepare("INSERT INTO messages_fts(text,session_id,node_id,src_row,role,created_at) VALUES (?,?,?,?,?,?)")
    .run("longhead " + "z".repeat(4087), "s1", 3, 3, "assistant", 103);
  f.prepare("INSERT INTO meta(k,v) VALUES ('usage_row_id', 5)").run();
  f.prepare("INSERT INTO meta(k,v) VALUES ('last_row_id', 5)").run();
  f.close();
}

const { indexNewRows, indexUsageRows, searchFts, usageBySession } = await import("../lib/searchIndex");

describe("search.db rewrite-key migration", () => {
  it("dedups usage_rows to one row per (session_id, node_id)", () => {
    const m = usageBySession()!;
    expect(m.get("s1")).toMatchObject({ responses: 1, inputTokens: 10, outputTokens: 1 });
  });

  it("dedups duplicated fts rows, keeping the newest copy", () => {
    const hits = searchFts("alpha")!;
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe("alpha final");
  });

  it("aux_v4 restores a capped row from the source, keeping fts_rowid", () => {
    // the seeded row is the 4KB prefix of node 3's real text — v4 must read
    // the source back and UPDATE in place
    const hits = searchFts("longtail")!;
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain("longhead");
    // rowid preserved — indexed_nodes.fts_rowid still points at it
    const f = new DatabaseSync(join(stateDir, "search.db"), { readOnly: true });
    const row = f
      .prepare(
        `SELECT f.rowid AS rid, i.fts_rowid AS ir FROM messages_fts f
           JOIN indexed_nodes i ON i.session_id = f.session_id AND i.node_id = f.node_id
           WHERE f.session_id = 's1' AND f.node_id = 3`,
      )
      .get() as { rid: number; ir: number };
    f.close();
    expect(row.rid).toBe(row.ir);
  });

  it("new schema carries UNIQUE(session_id, node_id)", () => {
    const f = new DatabaseSync(join(stateDir, "search.db"), { readOnly: true });
    const sql = (f.prepare("SELECT sql FROM sqlite_master WHERE name='usage_rows'").get() as { sql: string }).sql;
    f.close();
    expect(sql.toUpperCase()).toMatch(/UNIQUE\(session_id,\s*node_id\)|PRIMARY KEY\s*\(session_id,\s*node_id/i);
  });
});

describe("migration atomicity", () => {
  // a crash between CREATE and DROP leaves usage_rows_v2 behind — the next
  // boot's plain CREATE TABLE used to throw, fts() marked the index broken,
  // and search/usage stayed disabled until search.db was deleted by hand
  it("recovers when a leftover usage_rows_v2 exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dw-atom-state-"));
    process.env.DEVIN_WEB_STATE_DIR = dir;
    const f = new DatabaseSync(join(dir, "search.db"));
    f.exec("CREATE TABLE meta(k TEXT PRIMARY KEY, v INTEGER)");
    f.exec(`CREATE TABLE usage_rows(
      src_row INTEGER PRIMARY KEY, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, cache_create_tokens INTEGER NOT NULL)`);
    f.prepare("INSERT INTO usage_rows VALUES (?,?,?,?,?,?,?,?)").run(1, "s1", 1, 100, 10, 1, 0, 0);
    f.exec("CREATE TABLE usage_rows_v2(x INTEGER)"); // crash debris
    f.close();
    const { vi } = await import("vitest");
    vi.resetModules();
    const { usageBySession } = await import("../lib/searchIndex");
    const m = usageBySession();
    expect(m).not.toBeNull();
    expect(m!.get("s1")).toMatchObject({ responses: 1, inputTokens: 10 });
    vi.resetModules();
    process.env.DEVIN_WEB_STATE_DIR = stateDir;
  });

  // a mid-migration failure must roll EVERYTHING back — old schema intact,
  // aux_v unset — so the next boot retries from a clean slate instead of
  // wedging on a half-renamed table
  it("a failed migration rolls back to the old schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dw-atom-state-"));
    process.env.DEVIN_WEB_STATE_DIR = dir;
    const f = new DatabaseSync(join(dir, "search.db"));
    f.exec("CREATE TABLE meta(k TEXT PRIMARY KEY, v INTEGER)");
    f.exec(`CREATE TABLE usage_rows(
      src_row INTEGER PRIMARY KEY, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, cache_create_tokens INTEGER NOT NULL)`);
    f.prepare("INSERT INTO usage_rows VALUES (?,?,?,?,?,?,?,?)").run(1, "s1", 1, 100, 10, 1, 0, 0);
    // poison indexed_nodes with the wrong shape → the migration's final
    // backfill INSERT throws mid-transaction
    f.exec("CREATE TABLE indexed_nodes(bogus INTEGER)");
    f.close();
    const { vi } = await import("vitest");
    vi.resetModules();
    const { usageBySession } = await import("../lib/searchIndex");
    expect(usageBySession()).toBeNull(); // index disabled for this process…
    const g = new DatabaseSync(join(dir, "search.db"), { readOnly: true });
    const sql = (g.prepare("SELECT sql FROM sqlite_master WHERE name='usage_rows'").get() as { sql: string }).sql;
    expect(sql).toMatch(/src_row INTEGER PRIMARY KEY/i); // …but NOT half-migrated
    expect(g.prepare("SELECT v FROM meta WHERE k='aux_v'").get()).toBeUndefined();
    g.close();
    vi.resetModules();
    process.env.DEVIN_WEB_STATE_DIR = stateDir;
  });
});

describe("recreated sessions.db detection", () => {
  it("resets the cache when MAX(row_id) falls below the cursor", () => {
    // CLI db recreated → row ids restart below our cursor; the old index
    // would sit permanently stuck (WHERE row_id > cursor matches nothing)
    rmSync(join(cliDir, "sessions.db"));
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
    sdb
      .prepare(
        "INSERT INTO sessions(id,working_directory,backend_type,model,agent_mode,created_at,last_activity_at,title,main_chain_id,hidden) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run("s9", "/tmp/new", "local", "m", "default", 1, 1, "New", 1, 0);
    sdb
      .prepare(
        "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
      )
      .run("s9", 1, null, assistant("fresh", 7, 3), 200);
    sdb.close();
    // row_id 1 < cursors (5) — indexers must reset and rebuild
    indexUsageRows();
    indexNewRows();
    const m = usageBySession()!;
    expect(m.get("s1")).toBeUndefined();
    expect(m.get("s9")).toMatchObject({ responses: 1, inputTokens: 7, outputTokens: 3 });
    expect(searchFts("reply fresh")!.map((h) => h.sessionId)).toEqual(["s9"]);
  });

  it("the reset preserves version flags — no migration/roster rescan next boot", () => {
    // after the reset above, aux_v and indexed_sessions_v must still be set;
    // a blanket DELETE FROM meta would rerun both full scans on next boot
    const f = new DatabaseSync(join(stateDir, "search.db"), { readOnly: true });
    const keys = new Set(
      (f.prepare("SELECT k FROM meta").all() as { k: string }[]).map((r) => r.k),
    );
    f.close();
    expect(keys.has("aux_v")).toBe(true);
    expect(keys.has("indexed_sessions_v")).toBe(true);
  });
});

describe("aux_v4 failure is non-fatal", () => {
  // v4 is the first migration that reads sessions.db — if the source is
  // missing/unreadable it must warn + leave aux_v low (retry next boot),
  // NOT rethrow into fts()'s catch (ftsBroken kills search for the process)
  it("missing sessions.db → index still works, aux_v stays 3", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dw-v4-state-"));
    const cli2 = mkdtempSync(join(tmpdir(), "dw-v4-cli-")); // no sessions.db
    const f = new DatabaseSync(join(dir, "search.db"));
    f.exec("CREATE TABLE meta(k TEXT PRIMARY KEY, v INTEGER)");
    f.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(
      text, session_id UNINDEXED, node_id UNINDEXED, src_row UNINDEXED,
      role UNINDEXED, created_at UNINDEXED, tokenize = 'trigram')`);
    f.exec(`CREATE TABLE indexed_nodes(
      session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
      src_row INTEGER NOT NULL, fts_rowid INTEGER NOT NULL,
      PRIMARY KEY(session_id, node_id))`);
    f.prepare("INSERT INTO messages_fts(text,session_id,node_id,src_row,role,created_at) VALUES (?,?,?,?,?,?)")
      .run("cappedhead " + "z".repeat(4087), "s9", 1, 1, "assistant", 1);
    f.prepare("INSERT INTO indexed_nodes VALUES ('s9',1,1,1)").run();
    f.prepare("INSERT INTO meta(k,v) VALUES ('aux_v', 3)").run();
    f.close();
    const { vi } = await import("vitest");
    vi.resetModules();
    process.env.DEVIN_WEB_STATE_DIR = dir;
    process.env.DEVIN_CLI_DIR = cli2;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { searchFts } = await import("../lib/searchIndex");
    expect(searchFts("cappedhead")).toHaveLength(1); // index alive
    // v4 attempted the restore, failed to open the source, warned — not died
    expect(warn.mock.calls.some((c) => String(c[0]).includes("aux_v4"))).toBe(true);
    warn.mockRestore();
    const g = new DatabaseSync(join(dir, "search.db"), { readOnly: true });
    expect((g.prepare("SELECT v FROM meta WHERE k='aux_v'").get() as { v: number }).v).toBe(3);
    g.close();
    vi.resetModules();
    process.env.DEVIN_WEB_STATE_DIR = stateDir;
    process.env.DEVIN_CLI_DIR = cliDir;
  });
});
