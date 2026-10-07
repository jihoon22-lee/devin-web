/** Incremental copy of the message_nodes tree structure (parent links,
 *  roles, snippets) — the data the /tree panel needs without touching the
 *  30k-row session corpus on the request path. Lives in its own cache DB
 *  ($STATE_DIR/treecache.db) next to search.db; fully rebuildable.
 *
 *  Cursors are per-session on message_nodes.row_id (append-only). The CLI
 *  rewrites a node under a NEW row_id — stable identity is
 *  (session_id,node_id), so rows upsert on that key. Tree membership is
 *  NOT stored: real chains run thousands of nodes deep, so a stored
 *  root_id can't be maintained by bounded passes — summaries walk the
 *  forest with one recursive CTE at query time instead.
 */
import { mkdirSync } from "node:fs";
import { stateDir } from "./paths.mjs";
import { join } from "node:path";
import { messageMeta } from "./transcript";
import { openDb, type SqlDb } from "./sqlite";
import { openSessionsDb, type SessionsDb } from "./db";

const treeDbPath = () => join(stateDir(), "treecache.db");
const BATCH = 2000;
/** rows a single subtree re-resolution may touch — a runaway rewrite can't
 *  turn a request path into an unbounded walk */
const RESOLVE_LIMIT = 100_000;

export type TreeDb = SqlDb;

let cache: TreeDb | null = null;
let broken = false;

function db(): TreeDb | null {
  if (broken) return null;
  if (!cache) {
    try {
      mkdirSync(stateDir(), { recursive: true });
      const d = openDb(treeDbPath());
      // rebuildable cache — same pragmas as search.db
      d.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
      d.exec(`CREATE TABLE IF NOT EXISTS tree_edges(
        session_id TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        parent_node_id INTEGER,
        role TEXT NOT NULL DEFAULT '',
        is_user_input INTEGER,
        snippet TEXT NOT NULL DEFAULT '',
        created_at INTEGER,
        src_row INTEGER NOT NULL,
        message_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(session_id, node_id))`);
      d.exec(
        "CREATE TABLE IF NOT EXISTS tree_cursor(session_id TEXT PRIMARY KEY, last_row_id INTEGER NOT NULL)",
      );
      d.exec(`CREATE TABLE IF NOT EXISTS tree_summary_cache(
        session_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL DEFAULT '',
        main_head INTEGER,
        dirty INTEGER NOT NULL DEFAULT 1)`);
      // v2: message_id column — the CLI rewrites a streaming message under a
      // fresh sibling (same parent, same message_id), so draft-vs-branch can
      // only be told apart by message_id. A pre-mid table's rows are useless
      // → drop and let catchup rebuild (cache is fully rebuildable).
      // Transactional: a mid-migration crash must not leave a half-empty
      // mirror. Runs AFTER the CREATEs so the cursor/summary tables exist.
      const hasMid = d
        .prepare("SELECT name FROM pragma_table_info('tree_edges') WHERE name = 'message_id'")
        .get();
      if (!hasMid) {
        d.exec("BEGIN");
        try {
          d.exec("DROP TABLE tree_edges");
          d.exec("DELETE FROM tree_cursor");
          d.exec("DELETE FROM tree_summary_cache");
          d.exec(`CREATE TABLE tree_edges(
            session_id TEXT NOT NULL,
            node_id INTEGER NOT NULL,
            parent_node_id INTEGER,
            role TEXT NOT NULL DEFAULT '',
            is_user_input INTEGER,
            snippet TEXT NOT NULL DEFAULT '',
            created_at INTEGER,
            src_row INTEGER NOT NULL,
            message_id TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(session_id, node_id))`);
          d.exec("COMMIT");
        } catch (e) {
          d.exec("ROLLBACK");
          throw e;
        }
      }
      d.exec(
        "CREATE INDEX IF NOT EXISTS tree_edges_parent ON tree_edges(session_id, parent_node_id)",
      );
      cache = d;
    } catch {
      broken = true;
      return null;
    }
  }
  return cache;
}

interface EdgeRow {
  row_id: number;
  node_id: number;
  parent_node_id: number | null;
  chat_message: string;
  created_at: number | null;
}

const SNIPPET_LEN = 160;

function snippetOf(chatMessage: string): {
  role: string;
  isUser: number | null;
  snippet: string;
  mid: string;
} {
  const { text, role } = messageMeta(chatMessage);
  let mid = "";
  // mirrors transcript.ts's isInternalUserNode: the key present+falsy marks
  // an internal payload (0), absent on a user node still counts as input (1)
  let isUser: number | null = null;
  try {
    const m = JSON.parse(chatMessage) as {
      message_id?: string;
      metadata?: { is_user_input?: unknown } | null;
    };
    mid = m.message_id ?? "";
    if (role === "user") {
      isUser =
        m.metadata != null && "is_user_input" in m.metadata && !m.metadata.is_user_input ? 0 : 1;
    }
  } catch {
    if (role === "user") isUser = 1; // unparseable metadata — same fallback as the transcript
  }
  return { role, isUser, mid, snippet: text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LEN) };
}

/** Pull a session's new message_nodes rows into tree_edges. Per-session
 *  cursor keeps the request path bounded to THAT session's backlog — a
 *  sibling's bulk never delays this panel. Returns {done, added}. */
export function catchupTreeSession(
  sessionId: string,
  src?: SessionsDb,
): { done: boolean; added: number } {
  const f = db();
  if (!f) return { done: false, added: 0 };
  const own = !src;
  const s = src ?? openSessionsDb();
  try {
    const cur = (
      f.prepare("SELECT last_row_id AS v FROM tree_cursor WHERE session_id = ?").get(sessionId) as
        | { v: number }
        | undefined
    )?.v ?? 0;
    // source recreated → everything cached for the session is stale
    const maxSrc =
      (s.prepare("SELECT MAX(row_id) AS m FROM message_nodes WHERE session_id = ?").get(sessionId) as {
        m: number | null;
      }).m ?? 0;
    let since = cur;
    if (cur > 0 && maxSrc < cur) {
      f.prepare("DELETE FROM tree_edges WHERE session_id = ?").run(sessionId);
      f.prepare("DELETE FROM tree_cursor WHERE session_id = ?").run(sessionId);
      since = 0;
    }
    let added = 0;
    for (;;) {
      const rows = s
        .prepare(
          `SELECT row_id, node_id, parent_node_id, chat_message, created_at
           FROM message_nodes WHERE session_id = ? AND row_id > ? ORDER BY row_id LIMIT ?`,
        )
        .all(sessionId, since, BATCH) as unknown as EdgeRow[];
      if (!rows.length) break;
      const up = f.prepare(
        `INSERT INTO tree_edges(session_id, node_id, parent_node_id, role, is_user_input, snippet, created_at, src_row, message_id)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id, node_id) DO UPDATE SET
           parent_node_id=excluded.parent_node_id, role=excluded.role,
           is_user_input=excluded.is_user_input, snippet=excluded.snippet,
           created_at=excluded.created_at, src_row=excluded.src_row,
           message_id=excluded.message_id`,
      );
      f.exec("BEGIN");
      try {
        for (const r of rows) {
          const meta = snippetOf(r.chat_message);
          up.run(
            sessionId,
            r.node_id,
            r.parent_node_id,
            meta.role,
            meta.isUser,
            meta.snippet,
            r.created_at,
            r.row_id,
            meta.mid,
          );
          since = r.row_id;
          added++;
        }
        f.prepare(
          "INSERT INTO tree_cursor(session_id, last_row_id) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET last_row_id = excluded.last_row_id",
        ).run(sessionId, since);
        f.exec("COMMIT");
      } catch (e) {
        f.exec("ROLLBACK");
        throw e;
      }
      if (rows.length < BATCH) break;
    }
    if (added > 0) {
      // new edges invalidate the materialized summary — recompute lazily on
      // the next read so a bulk catchup pays the walk once, not per batch
      f.prepare(
        `INSERT INTO tree_summary_cache(session_id, dirty) VALUES (?, 1)
         ON CONFLICT(session_id) DO UPDATE SET dirty = 1`,
      ).run(sessionId);
    }
    return { done: true, added };
  } finally {
    if (own) s.close();
  }
}

/** One recursive walk over the session's whole forest — (root, node) pairs.
 *  The parent index serves every join step; on the real 33k-node corpus
 *  this costs tens of ms, well inside the request budget, and it never
 *  goes stale because nothing is pre-computed. */
const FOREST_WALK = `WITH RECURSIVE walk(root, node, iu, sn, cat) AS (
  SELECT e.node_id, e.node_id, e.is_user_input, e.snippet, e.created_at
    FROM tree_edges e
    WHERE e.session_id = ? AND (e.parent_node_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM tree_edges p
      WHERE p.session_id = e.session_id AND p.node_id = e.parent_node_id))
  UNION ALL
  SELECT w.root, e.node_id, e.is_user_input, e.snippet, e.created_at
    FROM walk w
    CROSS JOIN tree_edges e ON e.session_id = ? AND e.parent_node_id = w.node
  LIMIT 500000
)`;
// NOTE the CROSS JOIN: a plain JOIN lets SQLite drive the recursive step
// from the 33k-row edges side (session_id-prefix scan per step → ~68s on
// the real corpus); CROSS forces w-outer + parent-index probe (~44ms).
// Edge columns ride the walk so the aggregate needs no join-back probe.

/** message_id → final (max) node_id across the session's whole forest.
 *  A node whose message_id has a later occurrence is a superseded
 *  rewrite/replay — the max-id copy is the canonical display position.
 *  Cheap because tree_edges stores message_id as a plain column. */
export function midFinalPositions(sessionId: string, src?: SessionsDb): Map<string, number> {
  const m = new Map<string, number>();
  const f = db();
  if (!f) return m;
  try {
    catchupTreeSession(sessionId, src);
    for (const r of f
      .prepare(
        "SELECT message_id AS mid, MAX(node_id) AS mx FROM tree_edges WHERE session_id = ? AND message_id != '' GROUP BY message_id",
      )
      .all(sessionId) as { mid: string; mx: number }[]) {
      m.set(r.mid, r.mx);
    }
  } catch {
    // stale/broken cache → empty map → callers keep rows (safe direction)
  }
  return m;
}

export interface TreeSummaryItem {
  rootNodeId: number;
  headNodeId: number;
  createdAt: number | null;
  count: number;
  isMain: boolean;
  preview: string;
}

export interface TreeBranch {
  parentNodeId: number;
  children: { nodeId: number; snippet: string; role: string; isUserInput: boolean | null }[];
}

export interface TreeSummary {
  trees: TreeSummaryItem[];
  branches: TreeBranch[];
  branchTotal: number;
}

/** Cap the branch payload — pathological sessions can have thousands of
 *  divergence points; the panel only shows the newest ones. */
export const BRANCH_CAP = 300;

export function treeSummary(sessionId: string, src?: SessionsDb): TreeSummary {
  const empty: TreeSummary = { trees: [], branches: [], branchTotal: 0 };
  const f = db();
  const own = !src;
  const s = src ?? openSessionsDb();
  try {
    // a vanished session must not serve stale cache — check + sweep
    const exists = s.prepare("SELECT 1 AS x FROM sessions WHERE id = ?").get(sessionId);
    if (!exists) {
      f?.prepare("DELETE FROM tree_edges WHERE session_id = ?").run(sessionId);
      f?.prepare("DELETE FROM tree_cursor WHERE session_id = ?").run(sessionId);
      f?.prepare("DELETE FROM tree_summary_cache WHERE session_id = ?").run(sessionId);
      return empty;
    }
    if (!f) return empty;
    catchupTreeSession(sessionId, s);
    const mainHead =
      (s.prepare("SELECT main_chain_id AS m FROM sessions WHERE id = ?").get(sessionId) as {
        m: number | null;
      } | undefined)?.m ?? null;
    // serve the materialized summary unless the cursor moved (dirty) or the
    // main head changed without new rows (a compaction can repoint it)
    const cached = f
      .prepare(
        "SELECT payload AS p, main_head AS mh, dirty AS d FROM tree_summary_cache WHERE session_id = ?",
      )
      .get(sessionId) as { p: string; mh: number | null; d: number } | undefined;
    if (cached && !cached.d && cached.mh === mainHead) {
      return JSON.parse(cached.p) as TreeSummary;
    }
    const sum = computeSummary(f, sessionId, mainHead);
    f.prepare(
      `INSERT INTO tree_summary_cache(session_id, payload, main_head, dirty) VALUES (?, ?, ?, 0)
       ON CONFLICT(session_id) DO UPDATE SET payload = excluded.payload,
         main_head = excluded.main_head, dirty = 0`,
    ).run(sessionId, JSON.stringify(sum), mainHead);
    return sum;
  } finally {
    if (own) s.close();
  }
}

/** The heavy part of treeSummary — one recursive forest walk + the branch
 *  aggregation. Runs only when the cache is dirty/absent; on the real
 *  33k-node corpus ~50-100ms, then ~1ms reads until the next commit. */
function computeSummary(f: TreeDb, sessionId: string, mainHead: number | null): TreeSummary {

    // one recursive walk aggregates every tree at once: size, tip, the
    // root's created_at, first user/any snippet, and which root contains
    // the main head — no join-back, the edge columns ride the CTE row
    const aggs = f
      .prepare(
        `${FOREST_WALK}
         SELECT root, COUNT(*) AS n, MAX(node) AS head,
                MAX(CASE WHEN node = ? THEN 1 ELSE 0 END) AS isMain,
                MIN(CASE WHEN node = root THEN cat END) AS rootAt,
                MIN(CASE WHEN iu = 1 THEN node END) AS fu,
                MIN(CASE WHEN sn != '' THEN node END) AS fa
         FROM walk GROUP BY root ORDER BY root`,
      )
      .all(sessionId, sessionId, mainHead ?? -1) as {
      root: number;
      n: number;
      head: number;
      isMain: number;
      rootAt: number | null;
      fu: number | null;
      fa: number | null;
    }[];
    // fu/fa are the FIRST node's id, not the min text — resolve to snippets
    // by PK (one probe per tree, inside the cached compute path)
    const snAt = f.prepare(
      "SELECT snippet AS s FROM tree_edges WHERE session_id = ? AND node_id = ?",
    );

    const trees: TreeSummaryItem[] = aggs.map((a) => ({
      rootNodeId: a.root,
      headNodeId: a.isMain && mainHead != null ? mainHead : a.head,
      createdAt: a.rootAt,
      count: a.n,
      isMain: !!a.isMain,
      preview:
        (a.fu != null ? (snAt.get(sessionId, a.fu) as { s: string } | undefined)?.s : null) ||
        (a.fa != null ? (snAt.get(sessionId, a.fa) as { s: string } | undefined)?.s : null) ||
        "",
    }));

    const branchTotal =
      ((
        f
          .prepare(
            `SELECT COUNT(*) AS n FROM (
               SELECT parent_node_id FROM tree_edges
               WHERE session_id = ? AND parent_node_id IS NOT NULL
               GROUP BY parent_node_id HAVING COUNT(*) > 1)`,
          )
          .get(sessionId) as { n: number } | undefined
      )?.n ?? 0);
    // one pass: the IN-subquery feeds each parent through tree_edges_parent —
    // per-parent .all() loops would degrade to 33k-row index scans each
    // (sqlite picks the PK's session_id prefix over the parent index)
    const childRows = f
      .prepare(
        `SELECT e.parent_node_id AS p, e.node_id AS n, e.snippet AS s, e.role AS r,
                e.is_user_input AS u FROM tree_edges e
         WHERE e.session_id = ? AND e.parent_node_id IN (
           SELECT parent_node_id FROM tree_edges
           WHERE session_id = ? AND parent_node_id IS NOT NULL
           GROUP BY parent_node_id HAVING COUNT(*) > 1
           ORDER BY parent_node_id DESC LIMIT ?)
         ORDER BY e.parent_node_id, e.node_id`,
      )
      .all(sessionId, sessionId, BRANCH_CAP) as {
      p: number;
      n: number;
      s: string;
      r: string;
      u: number | null;
    }[];
    const byParent = new Map<number, TreeBranch["children"]>();
    for (const c of childRows) {
      let kids = byParent.get(c.p);
      if (!kids) byParent.set(c.p, (kids = []));
      kids.push({ nodeId: c.n, snippet: c.s, role: c.r, isUserInput: c.u == null ? null : !!c.u });
    }
  const branches: TreeBranch[] = [...byParent.entries()].map(([parentNodeId, children]) => ({
    parentNodeId,
    children,
  })); // childRows is ordered by parent — ascending list
  return { trees, branches, branchTotal };
}

/** One work segment on the history timeline — a maximal parent-contiguous
 *  run in display order. Compaction boundaries split segments: a grafted
 *  continuation starts a new segment while its compacted-away dead branch
 *  (parent-linked to the graft base) merges into the previous one. */
export interface SessionSegment {
  /** exclusive lower bound — `transcript?seg=<tip>&base=<base>` reads the
   *  segment's own rows, not the whole ancestry below it */
  base: number;
  tip: number;
  startNodeId: number;
  count: number;
  /** snippet of the first user-input node (falls back to any snippet) */
  firstPrompt: string;
  startAt: number | null;
  endAt: number | null;
  isMain: boolean;
  /** "history" = on the display chain; "branch" = off-chain alternate
   *  continuation (opened via ?branch= for its subtree+context) */
  kind: "history" | "branch";
}

interface EdgeLite {
  n: number;
  p: number | null;
  iu: number | null;
  sn: string;
  cat: number | null;
  mid: string;
}

const SEG_WINDOW = 4000;
/** hop budget across orphan trees — every compaction adds a root, so a
 *  long-lived session accumulates hundreds; each hop is one indexed
 *  ancestry walk, cheap enough to cover a deep forest */
const SEG_HOPS = 512;

/** Ancestor chain of `head` over the edge mirror — the same walk as
 *  db.ts's mainChainRows but light: no chat_message column (segment
 *  previews need only the stored snippet; the read path re-reads real
 *  rows from sessions.db). */
function edgeAncestry(f: TreeDb, sessionId: string, head: number, limit: number): EdgeLite[] {
  if (limit <= 0) return [];
  const rows = f
    .prepare(
      `WITH RECURSIVE chain(node_id, p, iu, sn, cat, mid, depth) AS (
         SELECT e.node_id, e.parent_node_id, e.is_user_input, e.snippet, e.created_at, e.message_id, 0
         FROM tree_edges e WHERE e.session_id = ? AND e.node_id = ?
         UNION ALL
         SELECT e.node_id, e.parent_node_id, e.is_user_input, e.snippet, e.created_at, e.message_id, c.depth + 1
         FROM chain c
         CROSS JOIN tree_edges e ON e.session_id = ? AND e.node_id = c.p
         WHERE c.depth + 1 < ?)
       SELECT node_id, p, iu, sn, cat, mid FROM chain ORDER BY depth ASC LIMIT ?`,
    )
    .all(sessionId, head, sessionId, limit, limit) as {
    node_id: number;
    p: number | null;
    iu: number | null;
    sn: string;
    cat: number | null;
    mid: string;
  }[];
  // depth order is newest-first → flip to chronological
  return rows
    .reverse()
    .map((r) => ({ n: r.node_id, p: r.p, iu: r.iu, sn: r.sn, cat: r.cat, mid: r.mid }));
}

/** Work-history timeline for the panel — the display-ordered node list
 *  (same expansion the transcript uses: graft gaps splice their dead
 *  branches in) split at every parent-link break, plus off-chain side
 *  branches. Runs entirely on the tree_edges mirror so a 30k-node corpus
 *  stays inside the request budget — no chat_message JSON is parsed. */
export function sessionSegments(
  sessionId: string,
  src?: SessionsDb,
): { segments: SessionSegment[] } {
  const empty = { segments: [] as SessionSegment[] };
  const f = db();
  if (!f) return empty;
  const own = !src;
  const s = src ?? openSessionsDb();
  try {
    const exists = s.prepare("SELECT 1 AS x FROM sessions WHERE id = ?").get(sessionId);
    if (!exists) return empty;
    catchupTreeSession(sessionId, s);
    const mainHead =
      (s.prepare("SELECT main_chain_id AS m FROM sessions WHERE id = ?").get(sessionId) as
        | { m: number | null }
        | undefined)?.m ?? null;

    const prevEdge = f.prepare(
      `SELECT node_id AS n, parent_node_id AS p, message_id AS mid FROM tree_edges
       WHERE session_id = ? AND node_id < ? ORDER BY node_id DESC LIMIT 1`,
    );
    const belowRow = (n: number): { n: number; p: number | null; mid: string } | null =>
      (prevEdge.get(sessionId, n) as { n: number; p: number | null; mid: string } | undefined) ??
      null;
    const edgeRow = f.prepare(
      "SELECT parent_node_id AS p, message_id AS mid FROM tree_edges WHERE session_id = ? AND node_id = ?",
    );
    /** a rewrite-draft is a SIBLING rewrite: same parent, same message_id,
     *  superseded by a higher-id twin. Checking (parent,mid) against the
     *  anchor is what separates drafts from compaction-replayed context —
     *  replayed rows share mids but live under different parents. */
    const isDraftOf = (c: { p: number | null; mid: string }, p: number | null, mid: string) =>
      !!c.mid && c.mid === mid && c.p === p;
    /** newest edge below `n` that isn't a draft of the anchor */
    const below = (n: number, mid = "", p: number | null = null): number | null => {
      let c = belowRow(n);
      for (let i = 0; i < 16 && c; i++) {
        if (!isDraftOf(c, p, mid)) return c.n;
        c = belowRow(c.n);
      }
      return null;
    };

    // main-chain membership + mid → final position — computed lazily, only
    // when a graft gap is found (gap content on the chain is a live sibling,
    // not dead history; a dead row whose mid has a later occurrence anywhere
    // is a superseded rewrite — the max-id copy is canonical)
    let mainIds: Set<number> | null = null;
    let finals: Map<string, number> | null = null;
    const mainSet = () => {
      if (!mainIds) {
        mainIds = new Set(
          mainHead != null
            ? edgeAncestry(f, sessionId, mainHead, SEG_WINDOW).map((r) => r.n)
            : [],
        );
      }
      return mainIds;
    };
    const finalPos = () => {
      if (!finals) {
        finals = new Map<string, number>();
        for (const r of f
          .prepare(
            "SELECT message_id AS mid, MAX(node_id) AS mx FROM tree_edges WHERE session_id = ? AND message_id != '' GROUP BY message_id",
          )
          .all(sessionId) as { mid: string; mx: number }[]) {
          finals.set(r.mid, r.mx);
        }
      }
      return finals;
    };

    // same splice as transcript-db's expandGraftGaps, on edge rows
    const expandEdges = (list: EdgeLite[], depth: number, budget: { n: number }): EdgeLite[] => {
      const out: EdgeLite[] = [];
      for (const r of list) {
        if (r.p != null && r.p < r.n - 1 && depth < 8 && budget.n > 0) {
          const tip = below(r.n, r.mid, r.p);
          if (tip != null && tip > r.p) {
            const seg = expandEdges(
              edgeAncestry(f, sessionId, tip, SEG_WINDOW).filter((x) => {
                if (x.n <= r.p! || mainSet().has(x.n)) return false;
                if (x.mid) {
                  const mx = finalPos().get(x.mid);
                  if (mx != null && mx !== x.n) return false;
                }
                return true;
              }),
              depth + 1,
              budget,
            );
            budget.n -= seg.length;
            out.push(...seg);
          }
        }
        out.push(r);
      }
      return out;
    };

    // collect the whole display-ordered history: ancestry hops upward,
    // crossing tree roots via the previous tree's tail — graft-dead content
    // arrives inline through expansion, so plain hops suffice
    const ordered: EdgeLite[] = [];
    const seen = new Set<number>();
    let head: number | null =
      mainHead ??
      ((
        f.prepare("SELECT MAX(node_id) AS m FROM tree_edges WHERE session_id = ?").get(sessionId) as
          | { m: number | null }
          | undefined
      )?.m ?? null);
    let hops = 0;
    while (head != null && hops++ < SEG_HOPS) {
      const walked = edgeAncestry(f, sessionId, head, SEG_WINDOW);
      if (!walked.length) {
        const e = edgeRow.get(sessionId, head) as { p: number | null; mid: string } | undefined;
        head = below(head, e?.mid ?? "", e?.p ?? null);
        continue;
      }
      const expanded = expandEdges(walked, 0, { n: SEG_WINDOW });
      const fresh: EdgeLite[] = [];
      for (const r of expanded) {
        if (!seen.has(r.n)) {
          seen.add(r.n);
          fresh.push(r);
        }
      }
      ordered.unshift(...fresh);
      // continue at the window-cut ancestor, else hop to the previous tree
      // (draft-skipping — a stale snapshot twin of the window root is not a
      // hop target)
      let next: number | null = walked[0].p;
      if (next == null) next = below(walked[0].n, walked[0].mid, walked[0].p);
      while (next != null && seen.has(next)) {
        const e = edgeRow.get(sessionId, next) as { p: number | null; mid: string } | undefined;
        next = below(next, e?.mid ?? "", e?.p ?? null);
      }
      head = next;
    }

    // split at every parent-link break — display order is node_id-ascending,
    // so a segment's read range is (previous segment tip, own tip]
    const runs: EdgeLite[][] = [];
    let cur: EdgeLite[] = [];
    for (const r of ordered) {
      if (cur.length && r.p !== cur[cur.length - 1].n) {
        runs.push(cur);
        cur = [];
      }
      cur.push(r);
    }
    if (cur.length) runs.push(cur);

    // compaction replays old context into the fresh tree with the SAME
    // message_ids — a segment preview should name the first prompt that is
    // NEW here, not the replayed original. `runs` is chronological, so a
    // mid seen by any earlier segment is replay, not new work.
    const olderMids = new Set<string>();
    const previewOf = (rows: EdgeLite[]): string => {
      const fresh = rows.find((r) => r.iu === 1 && (!r.mid || !olderMids.has(r.mid)));
      const pick = fresh ?? rows.find((r) => r.iu === 1) ?? rows.find((r) => r.sn);
      return pick?.sn ?? "";
    };
    const segments: SessionSegment[] = runs.map((rows, i) => {
      const first = rows[0];
      const last = rows[rows.length - 1];
      const seg = {
        base: i > 0 ? runs[i - 1][runs[i - 1].length - 1].n : 0,
        tip: last.n,
        startNodeId: first.n,
        count: rows.length,
        firstPrompt: previewOf(rows),
        startAt: first.cat,
        endAt: last.cat,
        isMain: mainHead != null && rows.some((r) => r.n === mainHead),
        kind: "history" as const,
      };
      for (const r of rows) if (r.mid) olderMids.add(r.mid);
      return seg;
    });

    // off-chain side branches — USER-INPUT children of multi-child parents
    // that no display row visited. The iu=1 gate is the snapshot filter:
    // the CLI rewrites each streaming message under a fresh sibling node
    // (same message_id, assistant role, iu NULL), so plain multi-child
    // detection flags thousands of snapshot pairs as branches. Only a
    // branch that starts with a real user prompt is a user-visible
    // alternate direction.
    const multi = f
      .prepare(
        `SELECT e.parent_node_id AS p, e.node_id AS n, e.message_id AS mid FROM tree_edges e
         WHERE e.session_id = ? AND e.is_user_input = 1 AND e.parent_node_id IN (
           SELECT parent_node_id FROM tree_edges
           WHERE session_id = ? AND parent_node_id IS NOT NULL
           GROUP BY parent_node_id HAVING COUNT(*) > 1)
         ORDER BY e.parent_node_id, e.node_id`,
      )
      .all(sessionId, sessionId) as { p: number; n: number; mid: string }[];
    const subtree = f.prepare(
      `WITH RECURSIVE d(node) AS (
         SELECT node_id FROM tree_edges WHERE session_id = ? AND node_id = ?
         UNION ALL
         SELECT e.node_id FROM d
         CROSS JOIN tree_edges e ON e.session_id = ? AND e.parent_node_id = d.node
         LIMIT ?)
       SELECT node AS n FROM d`,
    );
    // a rewrite-draft twin has a same-parent sibling with the same
    // message_id and a higher node_id — never a user-visible branch
    const draftProbe = f.prepare(
      `SELECT 1 AS x FROM tree_edges
       WHERE session_id = ? AND parent_node_id = ? AND message_id = ? AND node_id > ? LIMIT 1`,
    );
    for (const c of multi) {
      if (seen.has(c.n)) continue;
      if (c.mid && draftProbe.get(sessionId, c.p, c.mid, c.n)) continue;
      const desc = subtree.all(sessionId, c.n, sessionId, RESOLVE_LIMIT) as { n: number }[];
      const ids = desc.map((d) => d.n);
      for (const n of ids) seen.add(n);
      const rows = edgeAncestry(f, sessionId, Math.max(...ids), SEG_WINDOW).filter(
        (x) => x.n > c.p,
      );
      if (!rows.length) continue;
      segments.push({
        base: c.p,
        tip: rows[rows.length - 1].n,
        startNodeId: c.n,
        count: ids.length,
        firstPrompt: rows.find((r) => r.iu === 1)?.sn || rows.find((r) => r.sn)?.sn || "",
        startAt: rows[0].cat,
        endAt: rows[rows.length - 1].cat,
        isMain: false,
        kind: "branch",
      });
    }

    // current segment first, then newest-start-first
    segments.sort(
      (a, b) => Number(b.isMain) - Number(a.isMain) || b.startNodeId - a.startNodeId,
    );
    return { segments };
  } finally {
    if (own) s.close();
  }
}

/** Deepest node in `nodeId`'s subtree — the transcript tip to open when a
 *  branch child is picked. NULL when the node isn't indexed. */
export function branchTip(sessionId: string, nodeId: number): number | null {
  const f = db();
  if (!f) return null;
  catchupTreeSession(sessionId);
  const r = f
    .prepare(
      `WITH RECURSIVE d(node) AS (
         SELECT node_id FROM tree_edges WHERE session_id = ? AND node_id = ?
         UNION ALL
         SELECT e.node_id FROM d
         CROSS JOIN tree_edges e ON e.session_id = ? AND e.parent_node_id = d.node
         LIMIT ?
       )
       SELECT MAX(node) AS m, COUNT(*) AS n FROM d`,
    )
    .get(sessionId, nodeId, sessionId, RESOLVE_LIMIT) as { m: number | null; n: number } | undefined;
  return r?.n ? (r.m ?? null) : null;
}

/** Test helper: drop the cached handle so a rebuilt fixture is re-read. */
export function resetTreeIndex() {
  try {
    cache?.close();
  } catch {
    /* noop */
  }
  cache = null;
}
