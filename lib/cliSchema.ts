/** Columns read from the CLI-owned sessions.db by db, transcript, search,
 * tree/usage indexing, session routes, and TurnRegions' durable spine. */
import { openSessionsDb, type SessionsDb } from "./db";

export const CLI_COLUMNS: Record<string, string[]> = {
  message_nodes: ["row_id", "session_id", "node_id", "parent_node_id", "chat_message", "created_at"],
  sessions: ["id", "title", "working_directory", "hidden", "metadata", "main_chain_id"],
  tool_call_state: ["session_id", "tool_call_id", "tool_call_json", "tool_call_update_json"],
};

export interface CliSchemaCheck {
  ok: boolean;
  missing: string[];
  version: number | null;
}

export type CliSchemaHealth = CliSchemaCheck & { status: "compatible" | "drift" | "unavailable" };

/** Missing refinery_schema_history (or no migration rows) only makes the
 * version unknown; it does not hide missing application columns. */
export function checkCliSchema(db: SessionsDb): CliSchemaCheck {
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(CLI_COLUMNS)) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    const present = new Set(rows.map((row) => row.name));
    for (const column of columns) if (!present.has(column)) missing.push(`${table}.${column}`);
  }
  let version: number | null = null;
  try {
    const row = db.prepare("SELECT MAX(version) AS v FROM refinery_schema_history").get() as
      | { v: number | null }
      | undefined;
    version = row?.v ?? null;
  } catch (error) {
    // Older CLI databases can omit this table. Any other failure means we
    // could not read the DB reliably, so the health reader marks it unavailable.
    if (!(error instanceof Error && /^no such table: (?:main\.)?refinery_schema_history$/i.test(error.message)))
      throw error;
  }
  return { ok: missing.length === 0, missing, version };
}

const TTL_MS = 5 * 60 * 1000;

/** Per-process health probe. An unreadable DB has its own status and ok:false
 * so a failed open/query can never be reported as schema compatibility. */
export function createCliSchemaHealthReader(
  open: () => SessionsDb = openSessionsDb,
  now: () => number = Date.now,
): () => CliSchemaHealth {
  let cache: { at: number; value: CliSchemaHealth } | null = null;
  return () => {
    const at = now();
    if (cache && at - cache.at < TTL_MS) return cache.value;
    let value: CliSchemaHealth;
    try {
      const db = open();
      try {
        const check = checkCliSchema(db);
        value = { ...check, status: check.ok ? "compatible" : "drift" };
      } finally {
        db.close();
      }
    } catch {
      value = { ok: false, missing: [], version: null, status: "unavailable" };
    }
    cache = { at, value };
    return value;
  };
}
