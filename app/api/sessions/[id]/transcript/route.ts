import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVIN_CLI_DIR } from "@/lib/locks";
import { manager } from "@/lib/state";
import { readTranscriptDelta, readTranscriptItems } from "@/lib/transcript-db";
import { branchTip } from "@/lib/treeIndex";
import type { TranscriptItem } from "@/lib/transcript";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

interface AtifStep {
  source?: string;
  message?: string;
  timestamp?: string;
}

/** GET /api/sessions/:id/transcript — read-only history from sessions.db
 *  (fallback: transcripts/<id>.json). Used for locked sessions.
 *  ?after=<nodeId> → only items with id > after (incremental append);
 *  if after is stale (below the truncation floor) → full list + reset:true. */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const after = Number(sp.get("after") ?? 0) || 0;
  // ?tail=N → just the newest N items (bounded backfill for live sessions)
  const tail = Number(sp.get("tail") ?? 0) || 0;
  // ?before=<nodeId> → the page strictly older than that row (load-earlier
  // cursor); `truncated` in the response means history continues above
  const before = Number(sp.get("before") ?? 0) || 0;
  // ?head=<nodeId> → walk that node's ancestry instead of the main chain
  // (tree panel: viewing a branch or an orphaned pre-compaction tree)
  const head = Number(sp.get("head") ?? 0) || 0;
  // ?branch=<nodeId> → resolve to the deepest node in that subtree first
  const branch = Number(sp.get("branch") ?? 0) || 0;
  // ?seg=<tip>&base=<lowerBound> → one work-history segment's own span
  // (history panel) — the ancestry below base stays out
  const seg = Number(sp.get("seg") ?? 0) || 0;
  const segBase = Number(sp.get("base") ?? 0) || 0;
  const resolvedHead = head || seg || (branch ? (branchTip(id, branch) ?? branch) : 0);
  try {
    // incremental poll (the ~8s locked-session refresh) — parse only rows
    // newer than the client's cursor instead of the whole retained window
    if (after > 0 && !tail && !before && !resolvedHead) {
      const d = readTranscriptDelta(id, after);
      if (!d.reset) {
        // retained rides every response — a turn can finalize mid-view, and
        // its items anchor at positions the cursor already passed
        return NextResponse.json({
          items: d.items,
          truncated: false,
          source: "db",
          retained: manager().retained(id),
        });
      }
      const { items, truncated } = readTranscriptItems(id, {});
      if (items.length) {
        return NextResponse.json({
          items, truncated, source: "db", reset: true,
          retained: manager().retained(id),
        });
      }
      // empty db → fall through to the transcript file
    }
    const { items, truncated } = readTranscriptItems(
      id,
      tail || before || resolvedHead
        ? {
            tail: tail || undefined,
            before: before || undefined,
            head: resolvedHead || undefined,
            segBase: seg ? segBase : undefined,
          }
        : {},
    );
    // a `before` page that reaches the chain root is legitimately empty —
    // never fall through to the transcript-file path for it
    if (items.length || before) {
      const floor = items[0]?.id ?? 0;
      const out =
        after > 0 && after >= floor ? items.filter((i) => (i.id ?? 0) > after) : items;
      // client missed too much (window shifted) → resend all
      const reset = after > 0 && after < floor;
      // retained rides every paged response too — the client positions by
      // anchor and drops ids it already has, so the full list is safe and
      // simpler than window math (bounded by the per-session turn cap)
      return NextResponse.json({
        items: out, truncated, source: "db",
        retained: manager().retained(id),
        ...(reset ? { reset: true } : {}),
      });
    }
  } catch {
    /* fall through to transcript file */
  }

  const tPath = join(DEVIN_CLI_DIR, "transcripts", `${id}.json`);
  if (existsSync(tPath)) {
    try {
      const doc = JSON.parse(readFileSync(tPath, "utf8")) as { steps?: AtifStep[] };
      const items: TranscriptItem[] = (doc.steps ?? [])
        .filter((s) => s.source === "user" || s.source === "agent" || s.source === "tool")
        .map((s) => ({
          role: s.source === "agent" ? "assistant" : (s.source as TranscriptItem["role"]),
          text: s.message ?? "",
          ts: s.timestamp ? Date.parse(s.timestamp) : null,
        }))
        .filter((i) => i.text.trim());
      return NextResponse.json({ items, truncated: false, source: "transcript" });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }
  return NextResponse.json({ items: [], truncated: false, source: "none" });
}
