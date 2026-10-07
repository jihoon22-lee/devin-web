import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A valid empty CLI database for tests that read authoritative snapshots. */
export function createSessionsDb(cliDir: string): DatabaseSync {
  const db = new DatabaseSync(join(cliDir, "sessions.db"));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, main_chain_id INTEGER
    );
    CREATE TABLE message_nodes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL,
      created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id)
    );
    CREATE TABLE tool_call_state (
      session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
      tool_call_json TEXT, tool_call_update_json TEXT,
      PRIMARY KEY(session_id, tool_call_id)
    );
  `);
  return db;
}
