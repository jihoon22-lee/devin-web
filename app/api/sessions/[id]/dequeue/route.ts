import { NextResponse } from "next/server";
import { manager } from "@/lib/state";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST {id} — drop one queued prompt; returns its original blocks so the
 *  client can put it back into the input for editing.
 *  POST {id, send:true} — send-now: steer the prompt into the live turn. */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; send?: unknown };
  if (typeof body.id !== "string")
    return NextResponse.json({ error: "no such queued prompt" }, { status: 404 });
  if (body.send === true) {
    const res = manager().sendQueuedNow(id, body.id);
    if (!res) return NextResponse.json({ error: "no such queued prompt" }, { status: 404 });
    if (!res.sent)
      return NextResponse.json({ error: "session cannot send right now" }, { status: 409 });
    return NextResponse.json({ sent: true });
  }
  const res = manager().dequeue(id, body.id);
  if (!res) return NextResponse.json({ error: "no such queued prompt" }, { status: 404 });
  return NextResponse.json(res);
}
