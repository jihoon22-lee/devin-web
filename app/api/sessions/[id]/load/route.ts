import { NextRequest, NextResponse } from "next/server";
import { manager } from "@/lib/state";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/sessions/:id/load — load/resume a past session {cwd} */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { cwd } = (await req.json()) as { cwd?: string };
    if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    const res = await manager().loadSession(id, cwd);
    return NextResponse.json(res ?? { ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
