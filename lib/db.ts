/** Shared read-only access to the Devin CLI sessions.db.
 *  Centralizes the DatabaseSync open + the main-chain queries so transcript,
 *  export, search, history, and the stream mux don't each reinvent them. */
import { join } from "node:path";
import { DEVIN_CLI_DIR } from "@/lib/locks";
import { openDb, type SqlDb } from "./sqlite";
import type { MessageNodeRow } from "./transcript";

export const SESSIONS_DB = join(DEVIN_CLI_DIR, "sessions.db");

export type SessionsDb = SqlDb;

export function openSessionsDb(): SessionsDb {
  return openDb(SESSIONS_DB, { readOnly: true });
}

/** sessions.main_chain_id — head (newest) node of the session's main branch.
 *  NULL for old/empty sessions → callers fall back to the full-scan path. */
export function mainChainHead(db: SessionsDb, sessionId: string): number | null {
  const r = db
    .prepare("SELECT main_chain_id FROM sessions WHERE id = ?")
    .get(sessionId) as { main_chain_id: number | null } | undefined;
  return r?.main_chain_id ?? null;
}

/** Walk the parent chain from the head node entirely in SQL — newest-first,
 *  bounded to `limit` nodes. Fork branches are never read, so this stays fast
 *  even on sessions with large side chains (2-22, 3-1).
 *  Returns rows in chronological order (oldest → newest). */
export function mainChainRows(
  db: SessionsDb,
  sessionId: string,
  head: number,
  limit: number,
): MessageNodeRow[] {
  if (limit <= 0) return [];
  const rows = db
    .prepare(
      `WITH RECURSIVE chain(node_id, parent_node_id, chat_message, created_at, depth) AS (
         SELECT m.node_id, m.parent_node_id, m.chat_message, m.created_at, 0
         FROM message_nodes m WHERE m.session_id = ? AND m.node_id = ?
         UNION ALL
         SELECT m.node_id, m.parent_node_id, m.chat_message, m.created_at, c.depth + 1
         FROM message_nodes m
         JOIN chain c ON c.parent_node_id = m.node_id AND m.session_id = ?
         WHERE c.depth + 1 < ?
       )
       SELECT node_id, parent_node_id, chat_message, created_at
       FROM chain ORDER BY depth ASC LIMIT ?`,
    )
    .all(sessionId, head, sessionId, limit, limit) as unknown as MessageNodeRow[];
  return rows.reverse(); // depth order is newest-first → flip to chronological
}

/** Chain membership without the payload columns — a light pointer walk for
 *  reset/floor checks where parsing chat_message JSON would dominate. */
export function chainNodeIds(
  db: SessionsDb,
  sessionId: string,
  head: number,
  limit: number,
): number[] {
  if (limit <= 0) return [];
  const rows = db
    .prepare(
      `WITH RECURSIVE chain(node_id, parent_node_id, depth) AS (
         SELECT m.node_id, m.parent_node_id, 0
         FROM message_nodes m WHERE m.session_id = ? AND m.node_id = ?
         UNION ALL
         SELECT m.node_id, m.parent_node_id, c.depth + 1
         FROM message_nodes m
         JOIN chain c ON c.parent_node_id = m.node_id AND m.session_id = ?
         WHERE c.depth + 1 < ?
       )
       SELECT node_id FROM chain ORDER BY depth ASC LIMIT ?`,
    )
    .all(sessionId, head, sessionId, limit, limit) as unknown as { node_id: number }[];
  return rows.map((r) => r.node_id); // newest → oldest
}

/** Incremental rows: everything with node_id > `after`, chronological.
 *  Used by the transcript ?after= path and the stream mux's delta pushes. */
export function nodesAfter(db: SessionsDb, sessionId: string, after: number): MessageNodeRow[] {
  return db
    .prepare(
      "SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes WHERE session_id = ? AND node_id > ? ORDER BY node_id",
    )
    .all(sessionId, after) as unknown as MessageNodeRow[];
}

export function maxNodeId(db: SessionsDb, sessionId: string): number {
  const r = db
    .prepare("SELECT MAX(node_id) AS m FROM message_nodes WHERE session_id = ?")
    .get(sessionId) as { m: number | null } | undefined;
  return r?.m ?? 0;
}

/** Newest node per session via the UNIQUE(session_id, node_id) index — a
 *  covering scan instead of MAX(created_at) over every row (590ms → ~15-45ms
 *  on the 1.1GB / 87k-row db, identical results). node_id only grows within
 *  a session (fork nodes are appended too), so the max node IS the newest. */
export const SESSION_ACTIVITY_SQL = `SELECT m.session_id AS session_id, m.created_at AS t
  FROM (SELECT session_id, MAX(node_id) AS n FROM message_nodes GROUP BY session_id) h
  JOIN message_nodes m ON m.session_id = h.session_id AND m.node_id = h.n`;

/** Newest transcript node time per session (unix seconds) — the durable
 *  "last real work" timestamp. Unlike sessions.last_activity_at (which the
 *  CLI bumps on session/load), merely viewing a session never touches it. */
export function sessionActivity(db: SessionsDb): Map<string, number> {
  const rows = db.prepare(SESSION_ACTIVITY_SQL).all() as { session_id: string; t: number | null }[];
  const m = new Map<string, number>();
  for (const r of rows) if (r.t != null) m.set(r.session_id, r.t);
  return m;
}

/** Session ids the CLI flagged hidden — the web list mirrors the flag
 *  rather than showing sessions the user hid elsewhere. */
export function hiddenSessionIds(db: SessionsDb): Set<string> {
  try {
    const rows = db.prepare("SELECT id FROM sessions WHERE hidden = 1").all() as { id: string }[];
    return new Set(rows.map((r) => r.id));
  } catch {
    return new Set();
  }
}
