/** Isolated-session worktrees — `git worktree add $STATE_DIR/worktrees/<slug>
 *  -b devin-web/<slug>` gives each session its own checkout so concurrent
 *  sessions in the same repo never share a working tree (Changes tab,
 *  stage/commit all follow cwd). The record file is a hint keyed by path —
 *  worktrees outlive sessions, and `git worktree list` can always rebuild it. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { stateDir } from "./paths.mjs";
import { basename, join } from "node:path";
import { git, gitRoot } from "./gitChanges";

const stateFile = () => join(stateDir(), "worktrees.json");
const worktreeDir = () => join(stateDir(), "worktrees");

export interface WorktreeRec {
  branch: string;
  /** main repo root the worktree belongs to */
  repo: string;
  createdAt: string;
  sessionId?: string;
}

export interface WorktreeInfo extends WorktreeRec {
  path: string;
  missing?: boolean;
  dirty?: boolean;
}

let cache: Record<string, WorktreeRec> | null = null;
let cacheMtime = -1;

/** The file can also be rewritten by `devin-web-ctl worktrees rm` — a pure
 *  in-memory cache would resurrect deleted records on the next save. */
function load(): Record<string, WorktreeRec> {
  let mtime = -1;
  try {
    mtime = statSync(stateFile()).mtimeMs;
  } catch {
    /* absent */
  }
  if (cache && mtime === cacheMtime) return cache;
  try {
    const raw: unknown = JSON.parse(readFileSync(stateFile(), "utf8"));
    const out: Record<string, WorktreeRec> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (
          v &&
          typeof v === "object" &&
          typeof (v as WorktreeRec).branch === "string" &&
          typeof (v as WorktreeRec).repo === "string"
        ) {
          const r = v as WorktreeRec;
          out[k] = {
            branch: r.branch,
            repo: r.repo,
            createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
            ...(typeof r.sessionId === "string" ? { sessionId: r.sessionId } : {}),
          };
        }
      }
    }
    cache = out;
  } catch {
    cache = {};
  }
  cacheMtime = mtime;
  return cache;
}

function save(map: Record<string, WorktreeRec>) {
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${stateFile()}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(map) + "\n", { mode: 0o600 });
  renameSync(tmp, stateFile());
  cache = map;
  try {
    cacheMtime = statSync(stateFile()).mtimeMs;
  } catch {
    cacheMtime = -1;
  }
}

const rand = () => Math.random().toString(36).slice(2, 8);

/** Path + branch that collide with nothing — never reuse an existing branch
 *  name (the `-b` would fail anyway; we just pick a fresh slug). */
function freshSlug(repo: string): { slug: string; path: string; branch: string } {
  const base = basename(repo).replace(/[^a-zA-Z0-9._-]+/g, "-") || "repo";
  for (let i = 0; i < 20; i++) {
    const slug = `${base}-${rand()}`;
    const path = join(worktreeDir(), slug);
    const branch = `devin-web/${slug}`;
    if (existsSync(path)) continue;
    try {
      execFileSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      continue; // branch exists — retry
    } catch {
      return { slug, path, branch };
    }
  }
  throw new Error("could not mint a unique worktree slug");
}

/** Create `<STATE>/worktrees/<slug>` on a new `devin-web/<slug>` branch based
 *  on the repo's HEAD, and record it. `dir` may be any path inside the repo. */
export async function createWorktree(
  dir: string,
  sessionId?: string,
): Promise<WorktreeInfo> {
  const repo = await gitRoot(dir).catch(() => {
    throw new Error(`${dir} is not inside a git repository`);
  });
  const { path, branch } = freshSlug(repo);
  mkdirSync(worktreeDir(), { recursive: true });
  try {
    await git(repo, ["worktree", "add", path, "-b", branch]);
  } catch (e) {
    throw new Error(`git worktree add failed: ${(e as Error).message}`);
  }
  const rec: WorktreeRec = {
    branch,
    repo,
    createdAt: new Date().toISOString(),
    ...(sessionId ? { sessionId } : {}),
  };
  save({ ...load(), [path]: rec });
  return { path, ...rec };
}

/** Bind a record to the session that was created inside it. */
export function bindWorktreeSession(path: string, sessionId: string): void {
  const map = { ...load() };
  if (map[path]) {
    map[path] = { ...map[path], sessionId };
    save(map);
  }
}

/** The worktree record for a session cwd, if it is one of ours. */
export function worktreeForCwd(cwd: string): (WorktreeRec & { path: string }) | null {
  const rec = load()[cwd];
  return rec ? { path: cwd, ...rec } : null;
}

/** The worktree record bound to a session id — works for inactive sessions
 *  too (unlike a cwd lookup via the manager, which only knows attached ones). */
export function worktreeForSession(sessionId: string): (WorktreeRec & { path: string }) | null {
  for (const [path, r] of Object.entries(load())) {
    if (r.sessionId === sessionId) return { path, ...r };
  }
  return null;
}

function isDirty(path: string): boolean {
  try {
    const out = execFileSync("git", ["-C", path, "status", "--porcelain"], {
      timeout: 5000,
    }).toString();
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** All recorded worktrees with live dirty/missing state. */
export function listWorktrees(): WorktreeInfo[] {
  return Object.entries(load()).map(([path, r]) => {
    const missing = !existsSync(path);
    return { path, ...r, missing, dirty: missing ? false : isDirty(path) };
  });
}

/** `git worktree remove` — refuses dirty trees; the error is surfaced so the
 *  user can commit/stash and retry. On success the record is dropped. */
export async function removeWorktree(path: string): Promise<void> {
  const rec = load()[path];
  const repo = rec?.repo ?? (await gitRoot(path));
  await git(repo, ["worktree", "remove", path]);
  const map = { ...load() };
  delete map[path];
  save(map);
}

/** Session deleted — the worktree stays (uncommitted work may live there),
 *  but the session link is dropped. */
export function noteSessionDeleted(sessionId: string): void {
  const map = { ...load() };
  let changed = false;
  for (const [p, r] of Object.entries(map)) {
    if (r.sessionId === sessionId) {
      map[p] = { branch: r.branch, repo: r.repo, createdAt: r.createdAt };
      changed = true;
    }
  }
  if (changed) save({ ...map });
}
