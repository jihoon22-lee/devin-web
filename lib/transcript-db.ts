/** Server-side transcript read shared by the REST route and the session
 *  backfill path (adopted daemon sessions never replay session/load, so a
 *  resyncing client is seeded from the durable transcript instead). */
import { chainNodeIds, mainChainHead, mainChainRows, nodesAfter, openSessionsDb, type SessionsDb } from "@/lib/db";
import { midFinalPositions } from "@/lib/treeIndex";
import {
  attachToolState,
  rowToItem,
  rowsToTranscript,
  type MessageNodeRow,
  type TranscriptItem,
} from "@/lib/transcript";

/** Main-chain fetch window — enough headroom for filtered-out system/empty
 *  nodes while still bounded (3-1). */
const CHAIN_WINDOW = 4000;

/** The tail of the tree written before `belowNode` — compaction duplicates
 *  context into a fresh tree (root's parent NULL), orphaning the previous
 *  conversation; node ids are append-ordered so the node right below a
 *  root is the previous tree's tail. `prevRealHead` is the draft-skipping
 *  variant all current callers use. */

/** chat_message.message_id, parsed once per row object — the CLI rewrites a
 *  streaming message under a fresh SIBLING node (same parent, same id), so
 *  a numeric parent→child gap usually holds only discarded DRAFTS, not dead
 *  history. A gap row is real dead content only when its message_id differs
 *  from every on-chain twin. */
const midCache = new WeakMap<MessageNodeRow, string | null>();
function midOf(r: MessageNodeRow): string | null {
  let m = midCache.get(r);
  if (m === undefined) {
    m = null;
    try {
      m = (JSON.parse(r.chat_message) as { message_id?: string }).message_id ?? null;
    } catch {
      /* unparsed */
    }
    midCache.set(r, m);
  }
  return m;
}

/** prevTreeHead that skips rewrite-drafts of the anchor: the node right
 *  below a graft child is usually its own stale snapshot twin — same
 *  parent, same message_id, superseded by the child itself. Checking BOTH
 *  parent and mid is what separates a draft from compaction-replayed
 *  context (replayed rows share mids but live under different parents). */
function prevRealHead(
  db: SessionsDb,
  sessionId: string,
  belowNode: number,
  mid: string | null,
  parent: number | null,
): number | null {
  let cursor = belowNode;
  for (let i = 0; i < 16; i++) {
    const r = db
      .prepare(
        `SELECT node_id AS n, parent_node_id AS p,
                json_extract(chat_message,'$.message_id') AS mid
         FROM message_nodes WHERE session_id = ? AND node_id < ?
         ORDER BY node_id DESC LIMIT 1`,
      )
      .get(sessionId, cursor) as { n: number; p: number | null; mid: string | null } | undefined;
    if (!r) return null;
    if (mid != null && r.mid === mid && r.p === parent) {
      cursor = r.n;
      continue;
    }
    return r.n;
  }
  return null;
}

/** Find the main-chain boundary at a durable watermark. Keep the child of
 *  an edge crossing `through`: its graft gap can contain completed history
 *  newer than the eligible ancestor. Expansion needs that edge, but the
 *  boundary child itself must be removed before rendering. A fresh root
 *  above the watermark still uses the eligible older-tree fallback. */
function chainBoundaryAtOrBelow(
  db: SessionsDb,
  sessionId: string,
  through: number,
): number | null {
  const r = db
    .prepare(
      `WITH RECURSIVE walk(node_id, parent_node_id) AS (
         SELECT m.node_id, m.parent_node_id FROM message_nodes m
          JOIN sessions s ON s.id = m.session_id AND s.main_chain_id = m.node_id
          WHERE m.session_id = ?
         UNION ALL
         SELECT m.node_id, m.parent_node_id FROM walk w
          CROSS JOIN message_nodes m ON m.node_id = w.parent_node_id AND m.session_id = ?
          WHERE w.node_id > ? AND w.parent_node_id > ?
       )
       SELECT node_id FROM walk WHERE node_id <= ? OR parent_node_id <= ?
       ORDER BY node_id DESC LIMIT 1`,
    )
    .get(sessionId, sessionId, through, through, through, through) as { node_id: number } | undefined;
  return r?.node_id ?? null;
}

/** Any node older than the oldest walked row → earlier history exists
 *  above the rendered window (window cut OR a previous tree). */
function hasEarlierNodes(db: SessionsDb, sessionId: string, oldestNode: number): boolean {
  return !!db
    .prepare("SELECT 1 AS x FROM message_nodes WHERE session_id = ? AND node_id < ? LIMIT 1")
    .get(sessionId, oldestNode);
}

/** Dead-branch tip inside a graft gap: a compaction grafts the new
 *  continuation onto an old node, so a walked chain can jump backwards in
 *  node_id (child's parent ≪ child). The skipped numeric range holds the
 *  compacted-away segment's tail — unreachable by ancestry and skipped by a
 *  naive `below the window root` hop. Page the NEWEST such tip first (the
 *  most recent dead branch), then let the walk's own grafts recurse. */
function graftGapTip(db: SessionsDb, sessionId: string, rows: MessageNodeRow[]): number | null {
  let best = 0;
  let bestMid: string | null = null;
  let bestP: number | null = null;
  for (const r of rows) {
    const p = r.parent_node_id;
    if (p == null || p >= r.node_id - 1) continue; // adjacent or root — no gap
    const mid = midOf(r);
    const tip = prevRealHead(db, sessionId, r.node_id, mid, p);
    if (tip != null && tip > p && r.node_id > best) {
      best = r.node_id;
      bestMid = mid;
      bestP = p;
    }
  }
  return best ? prevRealHead(db, sessionId, best, bestMid, bestP) : null;
}

/** Splice dead branches into a walked chain. A compaction grafts the new
 *  continuation onto an old node (child's parent ≪ child); the numeric gap
 *  between them holds compacted-away segments that display BETWEEN parent
 *  and child but are unreachable by ancestry. Insert each gap's newest
 *  segment (its tail's ancestry minus the graft base) before the graft
 *  child — recursively, since dead segments carry their own grafts. Gap
 *  rows that are ON the main chain (a live sibling fork seen from a
 *  `?head=` branch view) are never spliced in — only orphaned content is
 *  "dead history". Inserted rows are capped; original rows never dropped. */
function expandGraftGaps(
  db: SessionsDb,
  sessionId: string,
  rows: MessageNodeRow[],
  mainSets: () => Set<number>,
  through?: number,
): MessageNodeRow[] {
  let grafts = 0;
  for (const r of rows) {
    const p = r.parent_node_id;
    if (p != null && p < r.node_id - 1) grafts++;
  }
  if (!grafts) return rows;
  let budget = CHAIN_WINDOW; // inserted-row cap — surplus is older history
  // message_id → final node_id (global). A spliced dead row whose mid has a
  // LATER occurrence anywhere — same-parent draft twin, re-anchored rewrite
  // under a new parent, replayed copy — is superseded; the max-id node is
  // the message's canonical display position and splicing both renders it
  // twice, triggering a duplicate integrity alarm.
  let finals: Map<string, number> | null = null;
  const finalPos = () => (finals ??= midFinalPositions(sessionId, db));
  const expand = (list: MessageNodeRow[], depth: number): MessageNodeRow[] => {
    const out: MessageNodeRow[] = [];
    for (const r of list) {
      const p = r.parent_node_id;
      if (p != null && p < r.node_id - 1 && depth < 8 && budget > 0) {
        const tip = prevRealHead(db, sessionId,
          through != null ? Math.min(r.node_id, through + 1) : r.node_id, midOf(r), p);
        if (tip != null && tip > p) {
          const main = mainSets();
          const seg = expand(
            mainChainRows(db, sessionId, tip, CHAIN_WINDOW).filter((x) => {
              if (x.node_id <= p || main.has(x.node_id)) return false;
              const xMid = midOf(x);
              if (xMid != null) {
                const mx = finalPos().get(xMid);
                if (mx != null && mx !== x.node_id) return false;
              }
              return true;
            }),
            depth + 1,
          );
          budget -= seg.length;
          out.push(...seg);
        }
      }
      out.push(r);
    }
    return out;
  };
  const expanded = expand(rows, 0);
  // overlapping graft children can splice the same dead range twice —
  // keep each row's first (earliest) display position
  const seen = new Set<number>();
  const deduped = expanded.filter((r) => !seen.has(r.node_id) && (seen.add(r.node_id), true));
  return deduped.length > CHAIN_WINDOW ? deduped.slice(-CHAIN_WINDOW) : deduped;
}

export function readTranscriptItems(
  sessionId: string,
  opts: { tail?: number; before?: number; head?: number; segBase?: number; through?: number } = {},
): {
  items: TranscriptItem[];
  truncated: boolean;
} {
  const db = openSessionsDb();
  try {
    // `head` walks an arbitrary node's ancestry (branch/tree browsing); the
    // default stays the session's live main-chain tip. `through` is the
    // durable watermark. Keep a crossing graft edge for history expansion,
    // then remove its above-watermark child before rendering. Explicit
    // branch heads and pagination retain their own cursor semantics.
    const seedThrough = opts.head == null && opts.before == null ? opts.through : undefined;
    let head =
      opts.head ??
      (opts.through != null
        ? chainBoundaryAtOrBelow(db, sessionId, opts.through)
        : mainChainHead(db, sessionId));
    if (head == null && seedThrough != null) {
      // A newer root (or legacy null main_chain_id) has no eligible
      // ancestor. Start at the latest eligible historical tip, using the
      // same bounded walk and graft expansion as a normal seed. A flat
      // rowsToTranscript fallback would discard this older tree's grafts.
      const eligible = db.prepare(
        `SELECT node_id FROM message_nodes WHERE session_id = ? AND node_id <= ?
         ORDER BY node_id DESC LIMIT 1`,
      ).get(sessionId, seedThrough) as { node_id: number } | undefined;
      if (!eligible) return { items: [], truncated: false };
      head = eligible.node_id;
    }
    let window = CHAIN_WINDOW;
    if (opts.before != null) {
      // page backwards: resume the chain at the cursor row's parent so the
      // response only carries strictly-older history
      const cur = db
        .prepare(
          `SELECT parent_node_id AS p, json_extract(chat_message,'$.message_id') AS mid
           FROM message_nodes WHERE session_id = ? AND node_id = ?`,
        )
        .get(sessionId, opts.before) as { p: number | null; mid: string | null } | undefined;
      head = cur?.p ?? null;
      if (head == null && cur) {
        // cursor IS a tree root — parent links can never cross a
        // compaction boundary, so hop to the previous tree's tail
        // (skipping rewrite-drafts of the cursor itself)
        head = prevRealHead(db, sessionId, opts.before, cur.mid, cur.p);
      } else if (cur && head != null) {
        // cursor is a graft child: a compaction grafted it onto an old node,
        // so session rows between parent and cursor are the dead branch that
        // conversationally precedes it — page its tail, not the parent.
        // Rows sharing the cursor's parent+message_id are its own
        // rewrite-drafts, not dead history — skip them.
        const tip = prevRealHead(db, sessionId, opts.before, cur.mid, cur.p);
        if (tip != null && tip > head) head = tip;
      }
      if (head == null) return { items: [], truncated: false };
      // enough rows for `tail` rendered items plus filtered-out slack
      window = Math.min(CHAIN_WINDOW, Math.max((opts.tail ?? 50) * 8, 200));
    }
    let rows: MessageNodeRow[] = [];
    let items: TranscriptItem[] = [];
    let itemsTruncated = false;
    let chainTruncated = false;
    if (head != null) {
      // main-chain membership — computed lazily, only when a graft gap is
      // found (gap content on the chain is a live sibling, not dead history)
      let mainIds: Set<number> | null = null;
      const mainSets = () => {
        if (!mainIds) {
          const mh = mainChainHead(db, sessionId);
          mainIds = new Set(
            mh != null ? chainNodeIds(db, sessionId, mh, CHAIN_WINDOW) : [],
          );
        }
        return mainIds;
      };
      // walk the main branch in SQL (recursive CTE) — fork branches and
      // ancient history beyond the window are never read into JS. A page
      // that renders NOTHING (all filtered) keeps searching: up the same
      // tree when the walk was window-cut, else across the compaction
      // boundary to the previous tree.
      for (let hop = 0; hop < 8 && head != null; hop++) {
        const walked = mainChainRows(db, sessionId, head, window);
        // an explicit ?head= that matches nothing is a dead cursor — hopping
        // to prevTreeHead would render an unrelated tree's tail instead
        if (!walked.length && opts.head != null) break;
        chainTruncated = walked.length === window;
        // graft gaps hold dead branches that display mid-chain — splice them
        // in so "load earlier" reaches compacted-away work instead of
        // skipping the numeric range forever. The expanded list IS display
        // order — map rows directly; rowsToTranscript would re-walk real
        // parent links from the max id and drop the spliced branches again.
        rows = expandGraftGaps(db, sessionId, walked, mainSets, seedThrough);
        if (seedThrough != null) rows = rows.filter((r) => r.node_id <= seedThrough);
        // a `seg` read bounds the view to the segment's own span — the
        // display-ordered rows between its base and tip; without the cut the
        // ancestry below the base would drag the whole earlier history in
        const segBase = opts.segBase;
        if (segBase != null) rows = rows.filter((r) => r.node_id > segBase);
        items = [];
        for (const r of rows) {
          const it = rowToItem(r);
          if (it) items.push(it);
        }
        itemsTruncated = items.length > 1000;
        if (itemsTruncated) items = items.slice(-1000); // same cap as rowsToTranscript
        // a bounded segment never hops below its base — an all-filtered
        // segment is legitimately empty, not a signal to keep paging
        if (items.length || opts.segBase != null) break;
        const sameTree = chainTruncated && walked.length ? walked[0].parent_node_id : null;
        head =
          sameTree ??
          graftGapTip(db, sessionId, walked) ??
          prevRealHead(
            db,
            sessionId,
            walked[0]?.node_id ?? head,
            walked[0] ? midOf(walked[0]) : null,
            walked[0]?.parent_node_id ?? null,
          );
      }
    } else {
      // No main_chain_id and no watermark: preserve the legacy read. A
      // watermark-bound seed uses the indexed historical-tip path above.
      rows = db
        .prepare(
          `SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes
           WHERE session_id = ?${opts.through != null ? " AND node_id <= ?" : ""}
           ORDER BY node_id`,
        )
        .all(...(opts.through != null ? [sessionId, opts.through] : [sessionId])) as unknown as MessageNodeRow[];
      const parsed = rowsToTranscript(rows);
      items = parsed.items;
      itemsTruncated = parsed.truncated;
    }
    // tail slices before the tool-state join — a bounded backfill shouldn't
    // pay to hydrate tool cards that are immediately dropped
    const out = opts.tail ? items.slice(-opts.tail) : items;
    if (out.length) attachToolState(db, sessionId, out);
    // earlier content also counts when the oldest walked row isn't the
    // session's oldest node — a compacted session's chain root is mid-forest
    const moreAbove = rows.length > 0 && hasEarlierNodes(db, sessionId, rows[0].node_id);
    return {
      items: out,
      truncated: itemsTruncated || chainTruncated || out.length < items.length || moreAbove,
    };
  } finally {
    db.close();
  }
}

/** Terminal tool_call_update payloads for calls whose completion never
 *  crossed the wire — an exec that killed the web mid-call (a `devin-web-ctl
 *  restart`) takes its own completion event down with it, so the replayed
 *  in_progress card would spin forever. The CLI's tool_call_state row is the
 *  durable truth; resync paths deliver these as synthetic updates so the
 *  card closes instead. */
export function finalToolUpdates(
  sessionId: string,
  toolCallIds: string[],
): Record<string, unknown>[] {
  if (!toolCallIds.length) return [];
  let rows: { tool_call_id: string; tool_call_update_json: string | null }[];
  try {
    const db = openSessionsDb();
    try {
      rows = db
        .prepare(
          `SELECT tool_call_id, tool_call_update_json FROM tool_call_state
           WHERE session_id = ? AND tool_call_id IN (${toolCallIds.map(() => "?").join(",")})`,
        )
        .all(sessionId, ...toolCallIds) as {
        tool_call_id: string;
        tool_call_update_json: string | null;
      }[];
    } finally {
      db.close();
    }
  } catch {
    return []; // sessions.db absent/older schema — nothing to reconcile
  }
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (!r.tool_call_update_json) continue;
    try {
      const upd = JSON.parse(r.tool_call_update_json) as Record<string, unknown>;
      if (upd.status !== "completed" && upd.status !== "failed") continue;
      out.push({ ...upd, sessionUpdate: "tool_call_update", toolCallId: r.tool_call_id });
    } catch {
      /* malformed row — skip */
    }
  }
  return out;
}

/** Incremental `?after=` read — parse only rows the client hasn't seen.
 *  `reset` means the cursor is stale (below the retained window) or off the
 *  main chain (fork remnant): the caller should resend the full window. */
export function readTranscriptDelta(
  sessionId: string,
  after: number,
): { items: TranscriptItem[]; reset: boolean } {
  const db = openSessionsDb();
  try {
    const head = mainChainHead(db, sessionId);
    if (head == null) return { items: [], reset: true }; // legacy → full path
    // newest→oldest chain ids — floor + membership without any JSON parse
    const chainIds = new Set(chainNodeIds(db, sessionId, head, CHAIN_WINDOW));
    if (!chainIds.size) return { items: [], reset: true };
    const floor = Math.min(...chainIds);
    if (after < floor || !chainIds.has(after)) return { items: [], reset: true };
    // everything newer than the cursor is inside the retained window —
    // nodesAfter is unbounded, so filter to main-chain members only
    const rows = nodesAfter(db, sessionId, after).filter((r) => chainIds.has(r.node_id));
    const { items } = rowsToTranscript(rows);
    if (items.length) attachToolState(db, sessionId, items);
    return { items, reset: false };
  } finally {
    db.close();
  }
}
