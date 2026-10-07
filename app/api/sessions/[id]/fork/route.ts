import { NextRequest, NextResponse } from "next/server";
import { manager } from "@/lib/state";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/sessions/:id/fork — fork session {cwd, nodeId?}.
 *  nodeId forks at the history step covering that node (the
 *  _cognition.ai/revert surface); without it the fork lands at the head. */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { cwd, nodeId } = (await req.json()) as { cwd?: string; nodeId?: number };
    const dir = cwd || manager().defaultCwd;
    const res =
      nodeId != null && Number.isFinite(nodeId) && nodeId > 0
        ? await manager().forkAtNode(id, dir, nodeId)
        : await manager().fork(id, dir);
    return NextResponse.json(res ?? { ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
