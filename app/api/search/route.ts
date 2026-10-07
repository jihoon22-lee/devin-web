import { NextResponse } from "next/server";
import { openSessionsDb } from "@/lib/db";
import { messageMeta } from "@/lib/transcript";
import { ftsCanServe, indexNewRows, projectSessionIds, scheduleCatchup, searchFts, searchLike, sessionMeta, type SearchFilter } from "@/lib/searchIndex";

export const dynamic = "force-dynamic";

const likeEscape = (s: string) => s.replace(/[%_\\]/g, (m) => `\\${m}`);

/** Accepts YYYY-MM-DD or a raw epoch number; `dayOffset` picks start vs end
 *  of day for date-only input. Returns undefined when absent/invalid. */
function toEpoch(v: string | null, dayOffset: number): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  return Math.floor(t / 1000) + dayOffset;
}

function snippet(text: string, q: string, span = 70): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, span * 2);
  const a = Math.max(0, i - span);
  const b = Math.min(text.length, i + q.length + span);
  return `${a > 0 ? "…" : ""}${text.slice(a, b)}${b < text.length ? "…" : ""}`.replace(/\s+/g, " ").trim();
}

interface Grouped {
  title: string | null;
  cwd: string;
  snippets: string[];
  /** first match — scroll target for "jump to message" */
  nodeId?: number;
  anchor?: string;
}

function pushSnippet(
  groups: Map<string, Grouped>,
  sessionId: string,
  meta: { title: string | null; cwd: string } | undefined,
  text: string,
  q: string,
  nodeId?: number,
) {
  const g = groups.get(sessionId) ?? { title: meta?.title ?? null, cwd: meta?.cwd ?? "", snippets: [] };
  if (g.nodeId == null && nodeId != null) {
    g.nodeId = nodeId;
    // anchor = normalized text prefix — lets the live chat view (whose items
    // have event ids, not node ids) locate the same message
    g.anchor = text.replace(/\s+/g, " ").trim().slice(0, 60);
  }
  if (g.snippets.length < 3) {
    const snip = snippet(text, q);
    // dedupe: identical/near-identical snippets (same node re-matched, or
    // repeated boilerplate) add no information
    const key = snip.replace(/\s+/g, "").toLowerCase();
    if (!g.snippets.some((s) => s.replace(/\s+/g, "").toLowerCase() === key)) g.snippets.push(snip);
  }
  groups.set(sessionId, g);
}

/** GET /api/search?q= — full-text search across all sessions' messages.
 *  Uses the incremental FTS5 index (lib/searchIndex) with a LIKE fallback.
 *  Returns up to 8 sessions, each with up to 3 matching snippets. */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const q = (sp.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ results: [] });
  // filters: project (exact cwd → session ids), date range (epoch
  // seconds via YYYY-MM-DD or raw number), tool-output toggle
  const cwd = (sp.get("cwd") ?? "").trim();
  const includeTools = sp.get("tools") !== "0";
  const from = toEpoch(sp.get("from"), 0);
  const to = toEpoch(sp.get("to"), 86399);

  try {
    const src = openSessionsDb(); // one handle shared by indexer + meta lookup
    try {
      indexNewRows(500, src); // small synchronous batch keeps results fresh…
      scheduleCatchup(); // …and a background loop finishes a cold corpus
      const flt: SearchFilter = { includeTools, from, to };
      if (cwd) flt.sessionIds = projectSessionIds(src, cwd);
      // the trigram index needs >= 3 characters per term — shorter terms
      // take a substring scan over the index's extracted text instead of
      // parsing every chat_message JSON blob
      const hits = ftsCanServe(q) ? searchFts(q, 400, flt) : searchLike(q, 400, flt);
      if (hits) {
        const meta = sessionMeta([...new Set(hits.map((h) => h.sessionId))], src);
        const groups = new Map<string, Grouped>();
        for (const h of hits) {
          const m = meta.get(h.sessionId);
          if (!m || m.hidden) continue; // session deleted since indexing, or hidden
          pushSnippet(groups, h.sessionId, m, h.text, q, h.nodeId);
          if (groups.size >= 8 && [...groups.values()].every((x) => x.snippets.length >= 3)) break;
        }
        return NextResponse.json({
          results: [...groups.entries()].slice(0, 8).map(([sessionId, g]) => ({
            sessionId,
            title: g.title,
            cwd: g.cwd,
            snippets: g.snippets,
            match: g.nodeId != null ? { nodeId: g.nodeId, anchor: g.anchor } : undefined,
          })),
        });
      }
    } finally {
      src.close();
    }

    // LIKE path — short terms, or FTS5 unavailable
    const db = openSessionsDb();
    try {
      const args: unknown[] = [`%${likeEscape(q)}%`];
      let where = `n.chat_message LIKE ? ESCAPE '\\' AND s.hidden = 0`;
      if (cwd) {
        where += " AND s.working_directory = ?";
        args.push(cwd);
      }
      if (from != null) {
        where += " AND n.created_at >= ?";
        args.push(from);
      }
      if (to != null) {
        where += " AND n.created_at <= ?";
        args.push(to);
      }
      const rows = db
        .prepare(
          `SELECT n.session_id, n.node_id, n.chat_message, n.created_at,
                  s.title, s.working_directory
           FROM message_nodes n JOIN sessions s ON s.id = n.session_id
           WHERE ${where}
           ORDER BY n.row_id DESC LIMIT 400`,
        )
        .all(...args) as unknown as {
        session_id: string;
        node_id: number;
        chat_message: string;
        title: string | null;
        working_directory: string;
      }[];
      const groups = new Map<string, Grouped>();
      for (const r of rows) {
        const { text, role } = messageMeta(r.chat_message);
        if (!text || (!includeTools && role === "tool")) continue;
        pushSnippet(groups, r.session_id, { title: r.title, cwd: r.working_directory }, text, q, r.node_id);
        if (groups.size >= 8 && [...groups.values()].every((x) => x.snippets.length >= 3)) break;
      }
      return NextResponse.json({
        results: [...groups.entries()].slice(0, 8).map(([sessionId, g]) => ({
          sessionId,
          title: g.title,
          cwd: g.cwd,
          snippets: g.snippets,
          match: g.nodeId != null ? { nodeId: g.nodeId, anchor: g.anchor } : undefined,
        })),
      });
    } finally {
      db.close();
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
