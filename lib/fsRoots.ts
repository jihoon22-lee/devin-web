import { resolve } from "node:path";
import { openSessionsDb } from "./db";
import { pathInRoots } from "./acp/fsGate.mjs";

/** Optional filesystem allowlist. When DEVIN_WEB_FS_ROOTS is set to a
 *  comma-separated list of directories, the browser fs routes only serve
 *  paths inside those roots (plus every session's cwd); agent fs requests
 *  use the stricter lib/acp/fsGate.mjs rule — roots plus the requesting
 *  session's own cwd. Unset → everything allowed (the default — the local
 *  file browser legitimately needs the whole tree; the request guard is the
 *  boundary).
 *  Note: this is lexical (resolve()) — a symlink inside a root that points
 *  outside it still passes. realpath-ing every request would be safer but
 *  costs a syscall per call; acceptable since the list is opt-in and the
 *  threat model is accidents, not a hostile same-uid process. */
const envRoots = (process.env.DEVIN_WEB_FS_ROOTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((r) => resolve(r));
let roots = envRoots;

/** Test hook — pass null to restore the env-derived list. */
export function setFsRootsForTest(list: string[] | null) {
  roots = list === null ? envRoots : list.map((r) => resolve(r));
}

/** The configured DEVIN_WEB_FS_ROOTS list — [] means "unrestricted".
 *  Used by creation-time checks: a session's cwd is auto-added to the
 *  allowlist via sessionRoots, so an arbitrary caller-supplied cwd would
 *  permanently widen a configured allowlist. */
export function configuredRoots(): readonly string[] {
  return roots;
}

/** Gate for a caller-supplied session cwd: a session's cwd later widens
 *  browser fs access (sessionRoots) and the agent fs gate, so while
 *  DEVIN_WEB_FS_ROOTS is configured it must lie inside it. Returns the 403
 *  message, or null when allowed. */
export function cwdRootsError(dir: string): string | null {
  return roots.length > 0 && !pathInRoots(dir, roots) ? `cwd outside DEVIN_WEB_FS_ROOTS: ${dir}` : null;
}

export { pathInRoots };

/** Session working directories are always browsable — a session's own
 *  project is legitimate file-browser territory even when DEVIN_WEB_FS_ROOTS
 *  narrows the static allowlist (otherwise a session whose cwd sits outside
 *  the web repo can't list its own files). Cached 30s: fs checks run per
 *  request while session dirs change rarely. Test-injectable via
 *  `setSessionRootsProvider`. */
const defaultSessionRootsProvider = (): string[] | null => {
  try {
    const db = openSessionsDb();
    try {
      const rows = db
        .prepare(
          "SELECT DISTINCT working_directory AS d FROM sessions WHERE working_directory IS NOT NULL",
        )
        .all() as { d: unknown }[];
      return rows.map((r) => String(r.d ?? "")).filter(Boolean);
    } finally {
      db.close();
    }
  } catch {
    return null; // db missing/locked — keep the stale cache
  }
};

let sessionRootsProvider = defaultSessionRootsProvider;

let sessionCache: { at: number; dirs: string[] } = { at: 0, dirs: [] };
const SESSION_ROOTS_TTL_MS = 30_000;

/** Test hook — pass null to restore the sessions.db-backed default. */
export function setSessionRootsProvider(fn: (() => string[] | null) | null) {
  sessionRootsProvider = fn ?? defaultSessionRootsProvider;
  sessionCache = { at: 0, dirs: [] };
}

function sessionRoots(): string[] {
  const now = Date.now();
  if (now - sessionCache.at < SESSION_ROOTS_TTL_MS) return sessionCache.dirs;
  const dirs = sessionRootsProvider();
  if (dirs !== null) sessionCache = { at: now, dirs: dirs.map((d) => resolve(d)) };
  return sessionCache.dirs;
}

export function fsPathAllowed(path: string): boolean {
  // pathInRoots([]) is "no restriction" (true) — an empty session list must
  // NOT open the gate, only an unset DEVIN_WEB_FS_ROOTS may
  const sr = sessionRoots();
  return pathInRoots(path, roots) || (sr.length > 0 && pathInRoots(path, sr));
}
