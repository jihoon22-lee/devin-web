import { NextResponse } from "next/server";
import { manager } from "@/lib/state";
import { readTranscriptItems } from "@/lib/transcript-db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/sessions/:id/prompts — the user's prompts on the displayed
 *  chain (same walk and durable watermark as the transcript), newest last:
 *  the Find sheet's outline. The client only holds a short tail, and a
 *  phone user shouldn't have to page "load earlier" to see what they asked.
 *  `truncated` = the chain continues past the read window. */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const { items, truncated } = readTranscriptItems(id, { through: manager().durableThrough(id) });
    const prompts = items
      .filter((i) => i.role === "user" && typeof i.id === "number" && i.text.trim() && !/^\[[a-z_]+\]$/i.test(i.text.trim()))
      .map((i) => ({ nodeId: i.id as number, text: i.text.slice(0, 400), ts: typeof i.ts === "number" ? i.ts * 1000 : undefined }));
    return NextResponse.json({ prompts, truncated });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
