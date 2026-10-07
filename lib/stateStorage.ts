/** Sizes of the state-dir databases and logs for /api/health — the search
 *  cache in particular grows with every session ever indexed (~0.9GB was
 *  observed on 2026-10-04) and nothing surfaced it. stat() only: cheap
 *  enough for the 30s health poll. */
import { statSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./paths.mjs";

/** above this a file is flagged — `ctl search-compact` (search.db) or a
 *  restart-time cleanup is worth considering */
export const STORAGE_WARN_BYTES = 1024 ** 3;

const FILES = ["search.db", "itemlog.db", "treecache.db", "server.log", "acpd.log"] as const;

const size = (p: string) => {
  try {
    return statSync(/*turbopackIgnore: true*/ p).size;
  } catch {
    return 0;
  }
};

export function stateStorage(): { files: Record<string, number>; total: number; warn: string[] } {
  const dir = stateDir();
  const files: Record<string, number> = {};
  let total = 0;
  const warn: string[] = [];
  for (const f of FILES) {
    // a database's WAL/SHM belong to it
    const n = size(join(/*turbopackIgnore: true*/ dir, f)) + (f.endsWith(".db") ? size(join(/*turbopackIgnore: true*/ dir, `${f}-wal`)) + size(join(/*turbopackIgnore: true*/ dir, `${f}-shm`)) : 0);
    files[f] = n;
    total += n;
    if (n >= STORAGE_WARN_BYTES) warn.push(f);
  }
  return { files, total, warn };
}
