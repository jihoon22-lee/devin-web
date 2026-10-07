/** Incremental FTS5 index over sessions.db message text.
 *
 *  The CLI's sessions.db is append-only (message_nodes.row_id is a global
 *  autoincrement), so indexing is a cheap cursor walk: keep
 *  `meta.last_row_id`, read rows above it, extract plain text, insert.
 *  Lives in its own cache DB ($STATE_DIR/search.db) so it can
 *  be deleted/rebuilt freely. (3-2) Tokenizer: trigram (substring search).
 *
 *  Queries run synchronously — FTS5 lookups are single-digit ms at this
 *  corpus size, so a worker thread would only add complexity.
 */
import { mkdirSync } from "node:fs";
import { stateDir } from "./paths.mjs";
import { join } from "node:path";
import { messageMeta } from "./transcript";
import { openDb, type SqlDb } from "./sqlite";
import { openSessionsDb, type SessionsDb } from "./db";

const searchDbPath = () => join(stateDir(), "search.db");

/** Rows indexed per maintenance pass — bounded so a cold start doesn't
 *  block the request that triggered it; subsequent passes finish the job. */
const INDEX_BATCH = 4000;

export type FtsDb = SqlDb;

/** Create the index tables. The index uses the trigram tokenizer (substring
 *  matching — Korean words carry particles and users type word fragments);
 *  an index built with the old unicode61 tokenizer is dropped and rebuilt. */
export function ensureFtsSchema(db: FtsDb) {
  db.exec("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER)");
  const cur = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
    .get() as { sql: string } | undefined;
  // schema v2 adds role + created_at (search filters) — anything older is
  // dropped and rebuilt from the source corpus. Dropping the fts table
  // invalidates: last_row_id (reindex from 0), indexed_sessions_v (reseed
  // the roster), indexed_nodes (its fts_rowids point at dead rows and new
  // rows will RECYCLE those rowids — a stale entry would delete the wrong
  // copy on the next rewrite). aux_v/usage_row_id stay valid: usage_rows
  // content is keyed on (session,node), independent of the fts rebuild.
  if (cur && (!/trigram/i.test(cur.sql) || !/role/i.test(cur.sql))) {
    db.exec("DROP TABLE messages_fts");
    // indexed_nodes may not exist yet — ensureAuxSchema runs after this
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='indexed_nodes'").get()) {
      db.exec("DELETE FROM indexed_nodes");
    }
    db.exec("DELETE FROM meta WHERE k NOT IN ('aux_v', 'usage_row_id')");
  }
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text, session_id UNINDEXED, node_id UNINDEXED, src_row UNINDEXED,
    role UNINDEXED, created_at UNINDEXED, tokenize = 'trigram')`);
}

/** Plain tables beside the FTS index — same rebuildable cache DB.
 *  usage_rows is keyed on (session_id, node_id) — NOT src_row: the CLI
 *  rewrites a message under a new row_id, and the src_row key used to keep
 *  both copies (~9% inflated usage on the live corpus). indexed_nodes maps
 *  each source node to its fts row so a rewrite can delete the stale copy —
 *  messages_fts.session_id/node_id are UNINDEXED and can't be queried
 *  directly without a full scan. */
export function ensureAuxSchema(db: FtsDb) {
  db.exec(`CREATE TABLE IF NOT EXISTS usage_rows(
    session_id TEXT NOT NULL,
    node_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_create_tokens INTEGER NOT NULL,
    src_row INTEGER NOT NULL,
    PRIMARY KEY(session_id, node_id))`);
  db.exec("CREATE INDEX IF NOT EXISTS usage_rows_created ON usage_rows(created_at)");
  db.exec(`CREATE TABLE IF NOT EXISTS indexed_nodes(
    session_id TEXT NOT NULL,
    node_id INTEGER NOT NULL,
    src_row INTEGER NOT NULL,
    fts_rowid INTEGER NOT NULL,
    PRIMARY KEY(session_id, node_id))`);
  db.exec("CREATE TABLE IF NOT EXISTS indexed_sessions(session_id TEXT PRIMARY KEY)");
}

/** One-time aux_v 1→2 migration: collapse the src_row-keyed usage_rows into
 *  (session_id,node_id)-keyed keeping the newest src_row, dedup messages_fts
 *  keeping the newest copy (max fts rowid == max src_row — rows insert in
 *  row_id order), then backfill indexed_nodes from what survived. Cursors
 *  stay put — no rebackfill needed. */
function migrateAuxV2(db: FtsDb) {
  const t0 = Date.now();
  // a previous crash may have left the staging table behind — a plain
  // CREATE would throw and wedge the index permanently
  db.exec("DROP TABLE IF EXISTS usage_rows_v2");
  const u = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usage_rows'")
    .get() as { sql: string } | undefined;
  // all-or-nothing: a mid-migration failure rolls back to the OLD schema
  // (aux_v stays < 2) so the next boot retries cleanly instead of wedging
  // on a half-renamed table — DDL rolls back inside a transaction too
  db.exec("BEGIN");
  try {
    if (u && /src_row\s+INTEGER\s+PRIMARY\s+KEY/i.test(u.sql)) {
      db.exec(`CREATE TABLE usage_rows_v2(
        session_id TEXT NOT NULL, node_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL, cache_create_tokens INTEGER NOT NULL,
        src_row INTEGER NOT NULL, PRIMARY KEY(session_id, node_id))`);
      db.exec(`INSERT INTO usage_rows_v2
        SELECT session_id, node_id, created_at, input_tokens, output_tokens,
               cache_read_tokens, cache_create_tokens, src_row
          FROM usage_rows
          WHERE src_row IN (SELECT MAX(src_row) FROM usage_rows GROUP BY session_id, node_id)`);
      db.exec("DROP TABLE usage_rows; ALTER TABLE usage_rows_v2 RENAME TO usage_rows");
      db.exec("CREATE INDEX IF NOT EXISTS usage_rows_created ON usage_rows(created_at)");
    }
    db.exec(
      "DELETE FROM messages_fts WHERE rowid NOT IN (SELECT MAX(rowid) FROM messages_fts GROUP BY session_id, node_id)",
    );
    db.exec(
      "INSERT OR REPLACE INTO indexed_nodes(session_id, node_id, src_row, fts_rowid) SELECT session_id, node_id, src_row, rowid FROM messages_fts",
    );
    setMeta(db, "aux_v", 2);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const ms = Date.now() - t0;
  if (ms > 500) console.warn(`[searchIndex] aux_v2 migration took ${ms}ms (one-time)`);
}

/** aux_v 3→4: the 4KB cap (v3) was reverted — recall over disk. Restore
 *  rows it truncated: read the source message back via indexed_nodes.src_row
 *  and UPDATE in place so fts_rowid stays valid. A src_row may dangle when
 *  the node was rewritten after indexing — skip (the newer copy is indexed
 *  separately). This is the first migration that reads sessions.db, so a
 *  source failure must NOT rethrow into fts()'s catch (ftsBroken disables
 *  search for the whole process): roll back, warn, leave aux_v<4 so the
 *  next boot retries. */
function migrateAuxV4(db: FtsDb) {
  const t0 = Date.now();
  try {
    const src = openSessionsDb();
    try {
      const getSrc = src.prepare("SELECT chat_message FROM message_nodes WHERE row_id = ?");
      const over = db
        .prepare(
          `SELECT f.rowid AS rid, i.src_row AS sr FROM messages_fts f
             JOIN indexed_nodes i ON i.fts_rowid = f.rowid
             WHERE LENGTH(f.text) >= 4096`,
        )
        .all() as { rid: number; sr: number }[];
      const upd = db.prepare("UPDATE messages_fts SET text = ? WHERE rowid = ?");
      db.exec("BEGIN");
      try {
        for (const r of over) {
          const row = getSrc.get(r.sr) as { chat_message?: string } | undefined;
          if (!row?.chat_message) continue;
          const { text } = messageMeta(row.chat_message);
          if (text) upd.run(text, r.rid);
        }
        setMeta(db, "aux_v", 4);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      src.close();
    }
  } catch (e) {
    console.warn(`[searchIndex] aux_v4 restore skipped (retry next boot): ${e instanceof Error ? e.message : e}`);
    return;
  }
  const ms = Date.now() - t0;
  if (ms > 500) console.warn(`[searchIndex] aux_v4 restore took ${ms}ms (one-time)`);
}

function metaValue(db: FtsDb, k: string): number {
  const r = db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: number } | undefined;
  return r?.v ?? 0;
}

function setMeta(db: FtsDb, k: string, v: number) {
  db.prepare("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

let ftsDb: FtsDb | null = null;
let ftsBroken = false; // FTS5 unavailable → callers use the LIKE fallback

function fts(): FtsDb | null {
  if (ftsBroken) return null;
  if (!ftsDb) {
    try {
      mkdirSync(stateDir(), { recursive: true });
      const db = openDb(searchDbPath());
      // rebuildable cache — WAL + relaxed sync: durability doesn't matter,
      // read/write concurrency and speed do
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
      ensureFtsSchema(db);
      ensureAuxSchema(db);
      if (metaValue(db, "aux_v") < 2) {
        migrateAuxV2(db); // sets aux_v itself, inside its transaction
      }
      if (metaValue(db, "aux_v") < 4) {
        migrateAuxV4(db); // restores v3-truncated text; non-fatal on failure
      }
      // one scan of the fts content, once per index, seeds the roster the GC
      // compares against sessions.db — later passes never scan
      if (metaValue(db, "indexed_sessions_v") < 1) {
        db.exec(
          "INSERT OR IGNORE INTO indexed_sessions(session_id) SELECT DISTINCT session_id FROM messages_fts",
        );
        setMeta(db, "indexed_sessions_v", 1);
      }
      ftsDb = db;
    } catch {
      ftsBroken = true;
      return null;
    }
  }
  return ftsDb;
}

function indexedUpto(db: FtsDb): number {
  const r = db.prepare("SELECT v FROM meta WHERE k = 'last_row_id'").get() as
    | { v: number }
    | undefined;
  return r?.v ?? 0;
}

/** Source row ids only move forward — a MAX below our cursor means
 *  sessions.db was recreated and every cached row is stale. The cache is
 *  fully rebuildable, so wipe it and let the cursors walk from 0 — but
 *  keep the version flags (aux_v/indexed_sessions_v): the schema is still
 *  current and dropping the flags would rerun the migration/roster full
 *  scans on next boot for no reason. */
function resetIfRecreated(f: FtsDb, db: SessionsDb, cursor: number): boolean {
  const m = (db.prepare("SELECT MAX(row_id) AS m FROM message_nodes").get() as { m: number | null }).m ?? 0;
  if (cursor === 0 || m >= cursor) return false;
  wipeIndexData(f);
  return true;
}

/** Data + cursors wiped, schema/version flags preserved — shared by the
 *  recreated-source reset and the test helper. */
function wipeIndexData(f: FtsDb) {
  f.exec(`DELETE FROM messages_fts; DELETE FROM usage_rows; DELETE FROM indexed_nodes;
    DELETE FROM indexed_sessions;
    DELETE FROM meta WHERE k NOT IN ('aux_v', 'indexed_sessions_v')`);
}

interface SourceRow {
  row_id: number;
  session_id: string;
  node_id: number;
  chat_message: string;
  created_at: number;
}

/** Index up to INDEX_BATCH new rows. Returns the number indexed.
 *  `src` may pass an already-open sessions.db handle (saves a reopen). */
export function indexNewRows(limit = INDEX_BATCH, src?: SessionsDb): number {
  const f = fts();
  if (!f) return 0;
  const own = !src;
  const db = src ?? openSessionsDb();
  try {
    const since = indexedUpto(f);
    if (resetIfRecreated(f, db, since)) return indexNewRows(limit, db);
    const rows = db
      .prepare(
        "SELECT row_id, session_id, node_id, chat_message, created_at FROM message_nodes WHERE row_id > ? ORDER BY row_id LIMIT ?",
      )
      .all(since, limit) as unknown as SourceRow[];
    if (!rows.length) return 0;
    const ins = f.prepare(
      "INSERT INTO messages_fts(text, session_id, node_id, src_row, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const delFts = f.prepare("DELETE FROM messages_fts WHERE rowid = ?");
    const prevNode = f.prepare(
      "SELECT src_row, fts_rowid FROM indexed_nodes WHERE session_id = ? AND node_id = ?",
    );
    const setNode = f.prepare(
      `INSERT INTO indexed_nodes(session_id, node_id, src_row, fts_rowid) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, node_id) DO UPDATE SET src_row = excluded.src_row, fts_rowid = excluded.fts_rowid`,
    );
    const delNode = f.prepare("DELETE FROM indexed_nodes WHERE session_id = ? AND node_id = ?");
    const setCur = f.prepare(
      "INSERT INTO meta(k, v) VALUES ('last_row_id', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    );
    const mark = f.prepare("INSERT OR IGNORE INTO indexed_sessions(session_id) VALUES (?)");
    // one transaction per batch — a row-per-commit would fsync every insert
    let max = since;
    f.exec("BEGIN");
    try {
      for (const r of rows) {
        max = r.row_id;
        mark.run(r.session_id);
        // a rewrite carries a new row_id for the same (session,node) — drop
        // the stale fts copy or it would stack beside the new one
        const prev = prevNode.get(r.session_id, r.node_id) as
          | { src_row: number; fts_rowid: number }
          | undefined;
        if (prev) delFts.run(prev.fts_rowid);
        const { text, role } = messageMeta(r.chat_message);
        if (!text.trim()) {
          if (prev) delNode.run(r.session_id, r.node_id); // system/empty rows are skipped entirely
          continue;
        }
        const res = ins.run(text, r.session_id, r.node_id, r.row_id, role, r.created_at) as
          | { lastInsertRowid?: number }
          | undefined;
        setNode.run(r.session_id, r.node_id, r.row_id, Number(res?.lastInsertRowid ?? 0));
      }
      setCur.run(max);
      f.exec("COMMIT");
    } catch (e) {
      f.exec("ROLLBACK");
      throw e;
    }
    return rows.length;
  } finally {
    if (own) db.close();
  }
}

let catchingUp = false;
/** Keep indexing in small batches off the request path until caught up —
 *  a cold corpus needs ~70 batches; without this every search during
 *  catch-up would eat a 4000-row JSON.parse batch. */
export function scheduleCatchup() {
  if (catchingUp) return;
  catchingUp = true;
  const step = () => {
    try {
      const text = indexNewRows();
      const usage = indexUsageRows();
      if (text >= INDEX_BATCH || usage >= USAGE_BATCH) {
        setTimeout(step, 25).unref?.();
        return;
      }
      runMaintenance(); // caught up → hourly optimize/GC/checkpoint, off the request path
    } catch {
      /* next trigger retries */
    }
    catchingUp = false;
  };
  setTimeout(step, 25).unref?.();
}

export const USAGE_BATCH = 2000;

interface UsageSrcRow {
  row_id: number;
  session_id: string;
  node_id: number;
  created_at: number;
  i: unknown;
  o: unknown;
  cr: unknown;
  cc: unknown;
}

const tok = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Extend usage_rows from sessions.db above the `usage_row_id` cursor —
 *  json_extract runs in SQLite (no JS parse); 2000 rows ≈ ≤105ms per step on
 *  the 87k-row corpus, so a cold backfill is ~44 background steps. Only
 *  assistant rows carry metrics — the rest just advance the cursor. */
export function indexUsageRows(limit = USAGE_BATCH, src?: SessionsDb): number {
  const f = fts();
  if (!f) return 0;
  const own = !src;
  const db = src ?? openSessionsDb();
  try {
    const since = metaValue(f, "usage_row_id");
    if (resetIfRecreated(f, db, since)) return indexUsageRows(limit, db);
    const rows = db
      .prepare(
        `SELECT row_id, session_id, node_id, created_at,
                json_extract(chat_message, '$.metadata.metrics.input_tokens') AS i,
                json_extract(chat_message, '$.metadata.metrics.output_tokens') AS o,
                json_extract(chat_message, '$.metadata.metrics.cache_read_tokens') AS cr,
                json_extract(chat_message, '$.metadata.metrics.cache_creation_tokens') AS cc
           FROM message_nodes WHERE row_id > ? ORDER BY row_id LIMIT ?`,
      )
      .all(since, limit) as unknown as UsageSrcRow[];
    if (!rows.length) return 0;
    // keyed on (session_id,node_id): a rewrite under a new row_id replaces
    // the stale copy; a rewrite that dropped metrics must delete it
    const ins = f.prepare(
      `INSERT OR REPLACE INTO usage_rows(session_id, node_id, created_at,
         input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, src_row)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const del = f.prepare("DELETE FROM usage_rows WHERE session_id = ? AND node_id = ?");
    const mark = f.prepare("INSERT OR IGNORE INTO indexed_sessions(session_id) VALUES (?)");
    f.exec("BEGIN");
    try {
      for (const r of rows) {
        mark.run(r.session_id);
        if (r.i == null) {
          del.run(r.session_id, r.node_id);
          continue;
        }
        ins.run(r.session_id, r.node_id, r.created_at, tok(r.i), tok(r.o), tok(r.cr), tok(r.cc), r.row_id);
      }
      setMeta(f, "usage_row_id", rows[rows.length - 1].row_id);
      f.exec("COMMIT");
    } catch (e) {
      f.exec("ROLLBACK");
      throw e;
    }
    return rows.length;
  } finally {
    if (own) db.close();
  }
}

export interface UsageSums {
  responses: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export function usageBySession(): Map<string, UsageSums> | null {
  const f = fts();
  if (!f) return null;
  const rows = f
    .prepare(
      `SELECT session_id AS s, COUNT(*) AS responses,
              SUM(input_tokens) AS i, SUM(output_tokens) AS o,
              SUM(cache_read_tokens) AS cr, SUM(cache_create_tokens) AS cc
         FROM usage_rows GROUP BY session_id`,
    )
    .all() as { s: string; responses: number; i: number; o: number; cr: number; cc: number }[];
  return new Map(
    rows.map((r) => [
      r.s,
      { responses: r.responses, inputTokens: r.i, outputTokens: r.o, cacheReadTokens: r.cr, cacheCreateTokens: r.cc },
    ]),
  );
}

/** Per LOCAL calendar day — 'unixepoch' alone buckets by UTC, so a KST
 *  evening would land on the next day's bar. */
export function usageDaily(sinceEpoch: number): { day: string; inputTokens: number; outputTokens: number }[] | null {
  const f = fts();
  if (!f) return null;
  return f
    .prepare(
      `SELECT date(created_at, 'unixepoch', 'localtime') AS day,
              SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens
         FROM usage_rows WHERE created_at >= ? GROUP BY day ORDER BY day`,
    )
    .all(sinceEpoch) as { day: string; inputTokens: number; outputTokens: number }[];
}

/** One session's responses in time order — the per-session drill-down.
 *  Newest `limit` rows, returned oldest → newest for left-to-right charts. */
export function usageSeries(
  sessionId: string,
  limit = 500,
): { at: number; inputTokens: number; outputTokens: number }[] {
  const f = fts();
  if (!f) return [];
  const rows = f
    .prepare(
      `SELECT created_at AS at, input_tokens AS inputTokens, output_tokens AS outputTokens
         FROM usage_rows WHERE session_id = ? ORDER BY created_at DESC, src_row DESC LIMIT ?`,
    )
    .all(sessionId, limit) as { at: number; inputTokens: number; outputTokens: number }[];
  return rows.reverse();
}

export function usageCursor(): number {
  const f = fts();
  return f ? metaValue(f, "usage_row_id") : 0;
}

/** Shortest term the trigram index can match. */
export const MIN_FTS_TERM = 3;

/** True when every whitespace-separated term is long enough for the trigram
 *  index; shorter terms need the substring (LIKE) scan instead. */
export function ftsCanServe(q: string): boolean {
  const terms = q.split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every((t) => [...t].length >= MIN_FTS_TERM);
}

/** Turn a user query into a safe FTS5 MATCH string: whitespace-separated
 *  terms, each double-quoted (literal) — no column filters or operators leak
 *  through from user input. */
function toMatch(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, "")}"`)
    .join(" ");
}

export interface FtsHit {
  sessionId: string;
  nodeId: number;
  text: string;
}

/** Search filters shared by the FTS and LIKE paths. `sessionIds` narrows to
 *  specific sessions (the project filter resolves cwd → ids first);
 *  `from`/`to` are epoch-second bounds on message created_at; `includeTools`
 *  keeps role='tool' rows (tool output is noise-heavy in results). */
export interface SearchFilter {
  sessionIds?: string[];
  from?: number;
  to?: number;
  includeTools?: boolean;
}

function filterClause(flt: SearchFilter | undefined, args: unknown[]): string {
  if (!flt) return "";
  let sql = "";
  if (flt.sessionIds) {
    // an explicit empty list (a project with no sessions) must match NOTHING —
    // skipping the clause used to return every session's hits
    if (!flt.sessionIds.length) return " AND 0";
    sql += ` AND session_id IN (${flt.sessionIds.map(() => "?").join(",")})`;
    args.push(...flt.sessionIds);
  }
  if (!flt.includeTools) {
    sql += " AND role != 'tool'";
  }
  if (flt.from != null) {
    sql += " AND created_at >= ?";
    args.push(flt.from);
  }
  if (flt.to != null) {
    sql += " AND created_at <= ?";
    args.push(flt.to);
  }
  return sql;
}

/** Search indexed message text, newest first. */
export function searchFts(q: string, limit = 400, flt?: SearchFilter): FtsHit[] | null {
  const f = fts();
  if (!f) return null;
  const match = toMatch(q);
  if (!match) return [];
  const args: unknown[] = [match];
  const where = filterClause(flt, args);
  args.push(limit);
  try {
    return f
      .prepare(
        `SELECT session_id AS sessionId, node_id AS nodeId, text
         FROM messages_fts WHERE messages_fts MATCH ?${where} ORDER BY src_row DESC LIMIT ?`,
      )
      .all(...args) as unknown as FtsHit[];
  } catch {
    return null; // malformed MATCH etc. → caller falls back
  }
}

/** Terms too short for trigram MATCH take a substring scan — but over the
 *  index's extracted text column, not sessions.db's chat_message JSON:
 *  same corpus, roughly half the bytes, and no per-row JSON.parse. */
export function searchLike(q: string, limit = 400, flt?: SearchFilter): FtsHit[] | null {
  const f = fts();
  if (!f) return null;
  const args: unknown[] = [`%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`];
  const where = filterClause(flt, args);
  args.push(limit);
  try {
    return f
      .prepare(
        `SELECT session_id AS sessionId, node_id AS nodeId, text
         FROM messages_fts WHERE text LIKE ? ESCAPE '\\'${where} ORDER BY src_row DESC LIMIT ?`,
      )
      .all(...args) as unknown as FtsHit[];
  } catch {
    return null;
  }
}

let lastMaintain = 0;
/** Merge fts segments, GC vanished sessions, truncate the WAL — hourly at
 *  most, from the catch-up loop only (never on a search request). */
function maybeMaintain(f: FtsDb, force = false) {
  const now = Date.now();
  if (!force && now - lastMaintain < 3_600_000) return;
  lastMaintain = now;
  try {
    f.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
  } catch {
    /* best-effort */
  }
  try {
    gcVanishedSessions(f);
  } catch {
    /* best-effort — sessions.db may be briefly unreadable */
  }
  try {
    f.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* best-effort */
  }
}

export function runMaintenance(force = false) {
  const f = fts();
  if (f) maybeMaintain(f, force);
}

/** Drop cache rows of sessions deleted from sessions.db. The live id list
 *  comes from our normal READ-ONLY handle — never attach sessions.db to
 *  this connection: it would inherit read-write mode, i.e. a writable
 *  handle on the CLI's database. The fts scan only runs when something
 *  actually vanished. */
function gcVanishedSessions(f: FtsDb): number {
  const indexed = (f.prepare("SELECT session_id AS s FROM indexed_sessions").all() as { s: string }[]).map(
    (r) => r.s,
  );
  if (!indexed.length) return 0;
  const db = openSessionsDb();
  let live: Set<string>;
  try {
    live = new Set((db.prepare("SELECT id FROM sessions").all() as { id: string }[]).map((r) => r.id));
  } finally {
    db.close();
  }
  const gone = indexed.filter((s) => !live.has(s));
  if (!gone.length) return 0;
  const ph = gone.map(() => "?").join(",");
  f.exec("BEGIN");
  try {
    f.prepare(`DELETE FROM messages_fts WHERE session_id IN (${ph})`).run(...gone);
    f.prepare(`DELETE FROM usage_rows WHERE session_id IN (${ph})`).run(...gone);
    f.prepare(`DELETE FROM indexed_nodes WHERE session_id IN (${ph})`).run(...gone);
    f.prepare(`DELETE FROM indexed_sessions WHERE session_id IN (${ph})`).run(...gone);
    f.exec("COMMIT");
  } catch (e) {
    f.exec("ROLLBACK");
    throw e;
  }
  return gone.length;
}

/** Deep reclaim — rebuild the fts postings tree, checkpoint, vacuum. Used
 *  by POST /api/search/compact (ctl search-compact); blocks briefly. */
export function compactSearchIndex(): boolean {
  const f = fts();
  if (!f) return false;
  try {
    f.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    f.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    f.exec("VACUUM");
    return true;
  } catch {
    return false;
  }
}

/** Sessions of exactly one project directory — the palette offers exact
 *  cwds; a LIKE substring also pulled `/x/devin-web-e2e` into `/x/devin-web`. */
export function projectSessionIds(db: SessionsDb, cwd: string): string[] {
  return (db.prepare("SELECT id FROM sessions WHERE working_directory = ?").all(cwd) as { id: string }[]).map(
    (r) => r.id,
  );
}

/** Session metadata for a set of ids (title/cwd/hidden filter lives in
 *  sessions.db, not the index). */
export function sessionMeta(ids: string[], src?: SessionsDb) {
  if (!ids.length) return new Map<string, { title: string | null; cwd: string; hidden: boolean }>();
  const own = !src;
  const db = src ?? openSessionsDb();
  try {
    const rows = db
      .prepare(
        `SELECT id, title, working_directory, hidden FROM sessions WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as { id: string; title: string | null; working_directory: string; hidden: number }[];
    return new Map(
      rows.map((r) => [r.id, { title: r.title, cwd: r.working_directory, hidden: !!r.hidden }]),
    );
  } finally {
    if (own) db.close();
  }
}

/** Test helper: drop the cached handle + wipe the index (fresh rebuild). */
export function resetSearchIndex() {
  try {
    if (ftsDb) wipeIndexData(ftsDb);
  } catch {
    /* noop */
  }
}
