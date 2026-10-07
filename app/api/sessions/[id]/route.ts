import { NextResponse } from "next/server";
import { manager } from "@/lib/state";
import { LockedSessionError } from "@/lib/locks";
import { noteSessionDeleted, worktreeForSession } from "@/lib/worktrees";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE /api/sessions/:id — delete a session. When the session lived in an
 *  isolated worktree, the worktree is left on disk (it may hold uncommitted
 *  work) and reported as `leftoverWorktree` so the UI can suggest cleanup. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const wt = worktreeForSession(id);
    const res = await manager().deleteSession(id);
    noteSessionDeleted(id);
    return NextResponse.json({
      ...(res ?? { ok: true }),
      ...(wt ? { leftoverWorktree: { path: wt.path, branch: wt.branch } } : {}),
    });
  } catch (e) {
    // a live foreign lock holder means "take over first" — that's a client
    // conflict, not a server failure
    if (e instanceof LockedSessionError)
      return NextResponse.json({ error: e.message }, { status: 409 });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
