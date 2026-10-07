import { NextResponse } from "next/server";
import { manager } from "@/lib/state";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST — create a share link via the CLI's `/share` command, sent through
 *  the normal prompt path — queues behind a running turn like any prompt. */
export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const res = (await manager().shareSession(id)) as Record<string, unknown>;
    return NextResponse.json(res ?? { ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
