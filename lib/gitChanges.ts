import { execFile } from "node:child_process";

/** git's well-known empty tree — the diff base in repositories with no commits */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface ChangedFile {
  path: string;
  status: string;
  /** X column: a change is in the index (unstage applies). */
  staged: boolean;
  /** Y column: worktree differs from index, or the file is untracked
   *  (stage applies). Unmerged paths get neither flag. */
  unstaged: boolean;
  additions: number;
  deletions: number;
}

export interface GitOpts {
  /** exit code 1 counts as success (`diff --no-index` uses it for "differs") */
  okExit1?: boolean;
  /** kill git after this long — default 10s (commit overrides it, see C1) */
  timeoutMs?: number;
}

/** Run git in `cwd`. Non-ASCII paths are printed verbatim (quotePath=false).
 *  `--literal-pathspecs`: every path we pass comes from porcelain output and
 *  is a literal file name — as a glob, `app/[id]/x` also matches `app/i/x`
 *  and a file named `*` matches the whole tree (Revert → data loss, H1). */
export function git(cwd: string, args: string[], opts: GitOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--literal-pathspecs", "-C", cwd, "-c", "core.quotePath=false", ...args],
      { timeout: opts.timeoutMs ?? 10_000, maxBuffer: 8 * 1024 * 1024 },
      (e, out) => {
        if (!e) return resolve(out);
        if (opts.okExit1 && (e as { code?: unknown }).code === 1) return resolve(out);
        reject(e);
      },
    );
  });
}

async function diffBase(cwd: string): Promise<string> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return "HEAD";
  } catch {
    return EMPTY_TREE;
  }
}

/** Porcelain paths are repository-relative even when the session lives in
 *  a subdirectory. Resolve every path operation against this same root. */
export async function gitRoot(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "");
}

/** `git status --porcelain=v1 -z`: records "XY path\0"; renames and copies
 *  are followed by an extra "origPath\0" record. */
export function parsePorcelainZ(out: string): { path: string; status: string; staged: boolean; unstaged: boolean }[] {
  const parts = out.split("\0");
  const files: { path: string; status: string; staged: boolean; unstaged: boolean }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const x = xy[0] ?? " ";
    const y = xy[1] ?? " ";
    files.push({
      path: rec.slice(3),
      status: xy.trim() || "?",
      staged: "MADRCT".includes(x),
      unstaged: "MDT".includes(y) || x === "?",
    });
    if (/[RC]/.test(xy)) i++; // skip the original-path record
  }
  return files;
}

/** `git diff --numstat -z`: "add\tdel\tpath\0"; renames are
 *  "add\tdel\t\0old\0new\0". Binary files report "-". */
export function parseNumstatZ(out: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const [a, d, p] = rec.split("\t");
    if (d === undefined) continue;
    let path = p;
    if (path === "") {
      path = parts[i + 2];
      i += 2;
    }
    if (path) stats.set(path, { additions: Number(a) || 0, deletions: Number(d) || 0 });
  }
  return stats;
}

/** Files changed in the working tree + index vs HEAD (or the empty tree). */
export async function changedFiles(cwd: string): Promise<ChangedFile[]> {
  cwd = await gitRoot(cwd);
  const base = await diffBase(cwd);
  const [porcelain, numstat] = await Promise.all([
    git(cwd, ["status", "--porcelain=v1", "-z", "-uall"]),
    git(cwd, ["diff", base, "--numstat", "-z"]).catch(() => ""),
  ]);
  const stats = parseNumstatZ(numstat);
  return parsePorcelainZ(porcelain).map((f) => ({
    ...f,
    ...(stats.get(f.path) ?? { additions: 0, deletions: 0 }),
  }));
}

/** Unified diff for one file; untracked files are diffed against /dev/null. */
export async function filePatch(cwd: string, file: string): Promise<string> {
  cwd = await gitRoot(cwd);
  const st = await git(cwd, ["status", "--porcelain=v1", "-z", "--", file]);
  if (st.startsWith("??")) {
    return git(cwd, ["diff", "--no-index", "--", "/dev/null", file], { okExit1: true });
  }
  return git(cwd, ["diff", await diffBase(cwd), "--", file]);
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ["branch", "--show-current"]).catch(() => "")).trim();
}

/** Stage one file (index ← worktree). */
export const stageFile = async (cwd: string, file: string) =>
  git(await gitRoot(cwd), ["add", "--", file]);

/** Unstage one file (worktree copy kept). */
export const unstageFile = async (cwd: string, file: string) =>
  git(await gitRoot(cwd), ["restore", "--staged", "--", file]);

/** Discard a file's changes — `git clean -f` for untracked files (no HEAD
 *  version to restore to), `git restore` for tracked ones. */
export async function revertFile(cwd: string, file: string) {
  cwd = await gitRoot(cwd);
  const st = await git(cwd, ["status", "--porcelain=v1", "-z", "--", file]);
  if (st.startsWith("??")) return git(cwd, ["clean", "-f", "--", file]);
  return git(cwd, ["restore", "--worktree", "--staged", "--", file]);
}

/** Commits run hooks (lint-staged, tests) and may wait on GPG signing — the
 *  10s default killed them mid-hook. */
export const COMMIT_TIMEOUT_MS = 120_000;

/** Commit everything currently staged. */
export const commitStaged = (cwd: string, message: string, timeoutMs = COMMIT_TIMEOUT_MS) =>
  git(cwd, ["commit", "-m", message], { timeoutMs });

/** Relative path without any `..` segment. */
export function isSafeRelPath(file: string): boolean {
  return !!file && !file.startsWith("/") && !file.split(/[\\/]/).includes("..");
}
