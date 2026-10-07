import { NextResponse } from "next/server";
import { manager } from "@/lib/state";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST {title} — rename via the CLI's `/rename` command, sent through the
 *  normal prompt path — queues behind a running turn like any prompt. */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  const title = body.title?.trim();
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
  try {
    const res = await manager().renameSession(id, title);
    return NextResponse.json({ ok: true, queued: res.queued });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
