/** Render-result integrity checks. The transcript's failure mode has always
 *  been "the same content rendered twice" or "a live item out of seq order",
 *  and until now the only detector was the user noticing. Cheap enough to run
 *  on every flush; reports go to /api/diag so remote (phone) sessions are
 *  covered too. */
import { renderItems, type ChatItem, type SessionState } from "./model";

/** shortest overlap worth reporting — shorter repeats occur naturally
 *  (a repeated "ok", boilerplate tool output) */
const MIN_DUP_CHARS = 100;

export interface IntegrityReport {
  dupes: { a: string; b: string; chars: number }[];
  disorder: { id: string; prev: number; cur: number }[];
}

const norm = (t: string) => t.replace(/\s+/g, " ").trim();

export function checkIntegrity(items: ChatItem[]): IntegrityReport {
  const dupes: IntegrityReport["dupes"] = [];
  const disorder: IntegrityReport["disorder"] = [];
  const byPrefix = new Map<string, string>(); // normalized head → first item id
  let lastSeq = 0;
  for (const it of items) {
    if (it.kind === "text") {
      const n = norm(it.text);
      if (n.length >= MIN_DUP_CHARS) {
        const key = `${it.role}|${n.slice(0, MIN_DUP_CHARS)}`;
        const first = byPrefix.get(key);
        if (first) dupes.push({ a: first, b: it.id, chars: n.length });
        else byPrefix.set(key, it.id);
      }
    }
    // only live/assembled items carry seqFrom — seeded (bf-) rows are
    // positioned by the durable transcript and must not be compared
    // against live seqs
    const sf = it.seqFrom;
    if (typeof sf === "number" && sf > 0) {
      if (sf < lastSeq) disorder.push({ id: it.id, prev: lastSeq, cur: sf });
      else lastSeq = sf;
    }
  }
  return { dupes, disorder };
}

/** The transcript regression alarm, as data: null when the rendered state
 *  is clean, else a signature (beacon only when it changes) and the body
 *  for /api/diag. Shared by every session hook. */
export function integrityBeacon(
  state: SessionState,
  sessionId: string | null,
): { sig: string; body: Record<string, unknown> } | null {
  const rendered = renderItems(state);
  const report = checkIntegrity(rendered);
  const sunk = state.sunkLive;
  // retained item anchored past every rendered durable row — its anchor row
  // is missing: an alignment or delivery leak, never pagination
  const dur = state.durable ?? [];
  const maxDurable = dur.reduce((m, i) => Math.max(m, Number(i.id.slice(3)) || 0), 0);
  const orphans = dur.length || (state.durableScannedThrough != null && !state.historyTruncated)
    ? (state.retained ?? []).filter((i) => i.anchor != null && i.anchor > maxDurable).length
    : 0; // no seed, or an empty truncated tail with anchors in older history
  if (!report.dupes.length && !report.disorder.length && !sunk && !orphans) return null;
  return {
    sig: `${report.dupes.length}:${report.disorder.length}:${report.dupes[0]?.b ?? ""}:${sunk?.pushed ?? 0}:${sunk?.inserted ?? 0}:${orphans}`,
    body: {
      s: sessionId,
      dupes: report.dupes.slice(0, 3),
      disorder: report.disorder.slice(0, 3),
      sunkLive: sunk,
      orphanAnchor: orphans || undefined,
      items: rendered.length,
    },
  };
}
