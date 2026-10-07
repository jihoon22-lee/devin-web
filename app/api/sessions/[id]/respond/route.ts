import { NextRequest, NextResponse } from "next/server";
import { manager } from "@/lib/state";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/sessions/:id/respond — answer a pending client request
 *  {requestId, result} or {requestId, cancel: true} */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { requestId, result, cancel } = (await req.json()) as {
      requestId: string;
      result?: unknown;
      cancel?: boolean;
    };
    // bind request→session: the URL's session must own the pending request,
    // or a caller could answer another session's permission card from here
    const ok = cancel
      ? manager().cancelRequest(requestId, id)
      : manager().respondToRequest(requestId, result, id);
    if (!ok) return NextResponse.json({ error: "no such pending request" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
