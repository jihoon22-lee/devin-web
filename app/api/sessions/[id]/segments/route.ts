import { NextResponse } from "next/server";
import { sessionSegments } from "@/lib/treeIndex";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/sessions/:id/segments — work-history timeline for the panel:
 *  display-ordered segments split at compaction boundaries (graft-dead
 *  branches splice into their pre-compaction segment) plus off-chain
 *  side branches. Computed on the tree_edges mirror — bounded per hop. */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const t0 = Date.now();
    const s = sessionSegments(id);
    const ms = Date.now() - t0;
    if (ms > 500) console.warn(`[segments] for ${id} took ${ms}ms`);
    return NextResponse.json(s);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
