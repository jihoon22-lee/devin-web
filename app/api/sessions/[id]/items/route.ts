import { NextResponse } from "next/server";
import { manager } from "@/lib/state";
import { readTranscriptItems } from "@/lib/transcript-db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/sessions/:id/items?tail=50 — the two-region transcript snapshot.
 *  `durable` = persisted rows up to `durableThrough`; `provisional` = the
 *  running turn assembled server-side. While a turn is provisional the
 *  watermark is frozen at its start, so mid-turn commits (which the
 *  provisional region already renders) never appear in `durable`. */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const tail = Number(sp.get("tail") ?? 0) || 0;
  const m = manager();
  const through = m.durableThrough(id);
  try {
    // `through` caps the read at the chain tip at-or-below the watermark —
    // NOT a post-filter: a running turn's mid-turn commits would otherwise
    // fill the tail window and leave durable empty
    const { items, truncated } = readTranscriptItems(id, {
      tail: tail || undefined,
      through: through || undefined,
    });
    const durable =
      through > 0 ? items.filter((i) => (i.id ?? 0) <= through) : [];
    return NextResponse.json({
      durable,
      durableTruncated: truncated,
      provisional: m.provisional(id),
      retained: m.retained(id),
      durableThrough: through,
    });
  } catch {
    return NextResponse.json({
      durable: [],
      durableTruncated: false,
      provisional: m.provisional(id),
      retained: m.retained(id),
      durableThrough: through,
    });
  }
}
