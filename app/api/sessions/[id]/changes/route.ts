import { NextResponse } from "next/server";
import { manager } from "@/lib/state";
import { changedFiles, changePaths, commitStaged, currentBranch, filePatch, gitRoot, isSafeRelPath, revertFile, stageFile, unstageFile } from "@/lib/gitChanges";
import { backupBeforeRevert, undoRevert } from "@/lib/revertTrash";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** The session's cwd, resolved server-side (never trust a client path).
 *  Attached sessions know it already — the panel polls every 5s, so avoid an
 *  ACP session/list round-trip per poll. */
async function sessionCwd(id: string): Promise<string | undefined> {
  const live = manager().getSession(id)?.cwd;
  if (live) return live;
  const sessions = await manager().listSessions().catch(() => []);
  return sessions.find((s) => s.sessionId === id)?.cwd;
}

/**
 * GET /api/sessions/:id/changes        → {files, branch} for the session cwd
 * GET /api/sessions/:id/changes?file=p → {patch} unified diff for one file
 */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const cwd = await sessionCwd(id);
  if (!cwd) return NextResponse.json({ error: "session cwd unknown" }, { status: 404 });

  const file = new URL(req.url).searchParams.get("file");
  try {
    if (file != null) {
      if (!isSafeRelPath(file)) {
        return NextResponse.json({ error: "invalid path" }, { status: 400 });
      }
      return NextResponse.json({ patch: await filePatch(cwd, file) });
    }
    const [files, branch] = await Promise.all([changedFiles(cwd), currentBranch(cwd)]);
    return NextResponse.json({ files, branch });
  } catch (e) {
    const msg = (e as Error).message;
    if (/not a git repository/i.test(msg)) {
      return NextResponse.json({ files: [], branch: "", notGit: true });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** POST {action: "stage"|"unstage"|"revert"|"commit", file?, message?} —
 *  working-tree actions for the Changes tab. File paths are validated;
 *  commit takes a message and commits whatever is staged. */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const cwd = await sessionCwd(id);
  if (!cwd) return NextResponse.json({ error: "session cwd unknown" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    file?: string;
    message?: string;
    undoId?: string;
  };
  const { action, file, message, undoId } = body;
  if (file != null && !isSafeRelPath(file)) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  try {
    switch (action) {
      case "stage":
        if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });
        await stageFile(cwd, file);
        break;
      case "unstage":
        if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });
        await unstageFile(cwd, file);
        break;
      case "revert": {
        if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });
        // copy the worktree bytes aside first — Revert is otherwise final
        const root = await gitRoot(cwd);
        const undoId = backupBeforeRevert(root, file, await changePaths(root, file));
        await revertFile(root, file);
        return NextResponse.json({ ok: true, undoId });
      }
      case "undo": {
        if (typeof undoId !== "string") return NextResponse.json({ error: "undoId required" }, { status: 400 });
        const meta = undoRevert(undoId, await gitRoot(cwd));
        return NextResponse.json({ ok: true, file: meta.file });
      }
      case "commit": {
        const msg = message?.trim();
        if (!msg) return NextResponse.json({ error: "message required" }, { status: 400 });
        await commitStaged(cwd, msg);
        break;
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
