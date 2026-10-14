// Agent fs gate shared by the web bridge (lib/acp/bridge.ts) and devin-acpd
// (lib/acp/daemon.mjs) — one rule on both paths: the configured
// DEVIN_WEB_FS_ROOTS plus the REQUESTING session's own cwd. Empty roots mean
// unrestricted. A relative path needs a known session cwd: falling back to
// the serving process's cwd dropped agent artifacts into the devin-web repo.
import { isAbsolute, resolve, sep } from "node:path";

/**
 * @param {string} path
 * @param {readonly string[]} rootList resolved roots; [] = unrestricted
 * @returns {boolean}
 */
export function pathInRoots(path, rootList) {
  if (!rootList.length) return true;
  const p = resolve(path);
  return rootList.some((r) => p === r || p.startsWith(r + sep));
}

/**
 * @param {unknown} rawPath path as sent by the agent
 * @param {string | null | undefined} sessionCwd the requesting session's cwd, if known
 * @param {readonly string[]} roots resolved configured roots; [] = unrestricted
 * @returns {string} absolute path to serve
 */
export function resolveAgentPath(rawPath, sessionCwd, roots) {
  const raw = String(rawPath ?? "");
  if (!sessionCwd && !isAbsolute(raw)) throw new Error(`relative path without a known session cwd: ${raw}`);
  const path = sessionCwd ? resolve(sessionCwd, raw) : resolve(raw);
  if (!pathInRoots(path, roots) && !(sessionCwd && pathInRoots(path, [resolve(sessionCwd)]))) {
    throw new Error(`path outside DEVIN_WEB_FS_ROOTS: ${raw}`);
  }
  return path;
}
