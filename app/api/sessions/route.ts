import { NextRequest, NextResponse } from "next/server";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { manager } from "@/lib/state";
import { DEVIN_CLI_DIR, lockOwner } from "@/lib/locks";
import { openSessionsDb, sessionActivity, hiddenSessionIds } from "@/lib/db";
import { allTags } from "@/lib/tags";
import { archivedMap } from "@/lib/archive";
import { bindWorktreeSession, createWorktree, removeWorktree, worktreeForCwd } from "@/lib/worktrees";
import { uiState } from "@/lib/uiState";
import { applySessionDefaults } from "@/lib/sessionDefaults";
import { configuredRoots, pathInRoots } from "@/lib/fsRoots";
import { itemLogModelMap } from "@/lib/itemLog";

export const dynamic = "force-dynamic";

const cmpVer = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

let verCache: { at: number; v: string | null } = { at: 0, v: null };
function latestDevinVersion(): string | null {
  if (Date.now() - verCache.at < 60_000) return verCache.v;
  try {
    const dirs = readdirSync(join(DEVIN_CLI_DIR, "_versions")).filter((d) => /^\d/.test(d));
    verCache = { at: Date.now(), v: dirs.sort(cmpVer).pop() ?? null };
    return verCache.v;
  } catch {
    return null;
  }
}

/** Last transcript-node time per session (unix seconds), cached briefly —
 *  the CLI's last_activity_at bumps on session/load, so merely opening a
 *  session would otherwise reorder the list and fire unread badges. The
 *  durable transcript only moves on real work. */
let actCache: { at: number; m: Map<string, number>; hidden: Set<string> } = {
  at: 0,
  m: new Map(),
  hidden: new Set(),
};
function sessionMeta(): { m: Map<string, number>; hidden: Set<string> } {
  if (Date.now() - actCache.at < 5000) return actCache;
  try {
    const db = openSessionsDb();
    try {
      actCache = { at: Date.now(), m: sessionActivity(db), hidden: hiddenSessionIds(db) };
    } finally {
      db.close();
    }
  } catch {
    /* db missing/locked — keep the stale data */
  }
  return actCache;
}

/** GET /api/sessions — list all sessions (optionally ?cwd=), with lock-owner info */
export async function GET(req: NextRequest) {
  try {
    const cwd = req.nextUrl.searchParams.get("cwd") || undefined;
    const m = manager();
    const { m: act, hidden } = sessionMeta();
    const tags = allTags();
    const arch = archivedMap();
    // one scan of itemlog's session_meta — sidebar model badges
    const models = itemLogModelMap();
    // one pass over the pending map — a per-session pendingFor() is O(N×M)
    const pendingCounts = new Map<string, number>();
    for (const pr of m.pendingFor()) {
      pendingCounts.set(pr.sessionId, (pendingCounts.get(pr.sessionId) ?? 0) + 1);
    }
    const sessions = (await m.listSessions(cwd))
      .filter((s) => !hidden.has(s.sessionId))
      .map((s) => {
        const owner = s.isLocked ? lockOwner(s.sessionId, m.bridgePid) : null;
        // override last_activity_at with the transcript-derived "last work"
        // time — viewing a session must not reorder lists or fire unread
        const t = act.get(s.sessionId);
        const updatedAt = t ? new Date(t * 1000).toISOString() : s.updatedAt;
        const wt = worktreeForCwd(s.cwd);
        const model = models.get(s.sessionId);
        return {
          ...s,
          updatedAt,
          lockedBy: owner ?? undefined,
          pendingRequests: pendingCounts.get(s.sessionId) ?? 0,
          tags: tags[s.sessionId] ?? [],
          archived: s.sessionId in arch,
          ...(model ? { model } : {}),
          ...(wt ? { worktree: { branch: wt.branch, repo: wt.repo } } : {}),
        };
      });
    return NextResponse.json({ sessions, devinLatest: latestDevinVersion() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** POST /api/sessions — create a new session {cwd, worktree?}.
 *  `worktree:true` first adds an isolated git worktree under
 *  $STATE_DIR/worktrees/ and makes that the session cwd. */
export async function POST(req: NextRequest) {
  try {
    const { cwd, worktree } = (await req.json()) as { cwd?: string; worktree?: boolean };
    const dir = cwd || manager().defaultCwd;
    // a session's cwd is auto-added to the fs allowlist via sessionRoots —
    // validate while it's still caller input, or one POST could open the
    // whole tree when DEVIN_WEB_FS_ROOTS is configured. Check before stat
    // so rejected paths cannot disclose whether a directory exists.
    const roots = configuredRoots();
    if (roots.length > 0 && !pathInRoots(dir, roots)) {
      return NextResponse.json({ error: `cwd outside DEVIN_WEB_FS_ROOTS: ${dir}` }, { status: 403 });
    }
    try {
      if (!statSync(dir).isDirectory()) {
        return NextResponse.json({ error: `not a directory: ${dir}` }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: `not a directory: ${dir}` }, { status: 400 });
    }
    const m = manager();
    // persisted sessionDefaults (model/thought_level/speed) applied before
    // the response — a failing default must never fail creation
    const applyDefaults = (res: Awaited<ReturnType<typeof m.createSession>>) =>
      applySessionDefaults(
        (cid, v) => m.setConfigOption(res.sessionId, cid, v),
        uiState().sessionDefaults ?? {},
        res.configOptions,
      ).catch((e) => console.error("[session-defaults]", e));
    let wt = null;
    if (worktree) {
      wt = await createWorktree(dir);
      try {
        const res = await m.createSession(wt.path);
        bindWorktreeSession(wt.path, res.sessionId);
        await applyDefaults(res);
        return NextResponse.json({ ...res, worktree: wt });
      } catch (e) {
        // roll back the just-created (guaranteed clean) worktree
        await removeWorktree(wt.path).catch(() => {});
        throw e;
      }
    }
    const res = await m.createSession(dir);
    await applyDefaults(res);
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
