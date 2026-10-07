import { NextRequest, NextResponse } from "next/server";
import { manager } from "@/lib/state";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/sessions/:id/dismiss-notice — drop an overlay notice {id}.
 *  Server-authoritative: every connected view loses it together. */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id: sessionId } = await ctx.params;
    const { id } = (await req.json()) as { id?: unknown };
    if (typeof id !== "string" || !id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }
    if (!manager().dismissNotice(sessionId, id)) {
      return NextResponse.json({ error: "no such notice" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
