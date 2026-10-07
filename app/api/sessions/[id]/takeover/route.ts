import { NextRequest, NextResponse } from "next/server";
import { manager } from "@/lib/state";
import { lockOwner, killLockOwner, removeLock } from "@/lib/locks";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const LOCKED = /already open in another process|session_locked/i;

/** POST /api/sessions/:id/takeover — force-load a locked session:
 *  kill the process holding its lock (devin CLI/acp), drop the stale lock
 *  file, then session/load. Destructive: the holder's process is terminated. */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { cwd } = (await req.json()) as { cwd?: string };
    if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    const m = manager();

    try {
      await m.loadSession(id, cwd);
      return NextResponse.json({ ok: true, took: false, killed: [] });
    } catch (e) {
      if (!LOCKED.test((e as Error).message)) throw e;
    }

    // lock attribution: in daemon mode the acp agent's pid lives in the
    // daemon's shim state, not in bridge.pid — an unattributed live devin
    // holder must never be signalled (it could be our own agent)
    let ourPid = m.bridgePid;
    if (ourPid == null && m.bridge.socketMode) {
      ourPid = (await m.bridge.daemonState())?.acpPid ?? null;
    }
    const owner = lockOwner(id, ourPid);
    if (owner?.alive && owner.isDevin && !owner.ours && ourPid == null) {
      return NextResponse.json(
        { error: "lock holder is a live devin process but our agent's pid is unknown — refusing to signal it" },
        { status: 409 },
      );
    }
    // only kill a live devin holder; a live non-devin pid means the lock file
    // is stale (pid reused) — just drop the file below
    const killed = owner?.alive && !owner.ours && owner.isDevin ? await killLockOwner(owner) : [];
    removeLock(id); // holder dead (or file already stale) — let devin reclaim

    try {
      await m.loadSession(id, cwd);
      return NextResponse.json({ ok: true, took: killed.length > 0, killed });
    } catch (e) {
      return NextResponse.json(
        { error: `takeover failed after killing holder: ${(e as Error).message}`, killed },
        { status: 500 },
      );
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
