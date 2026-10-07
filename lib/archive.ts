/** Web-side session archive — $STATE_DIR/archive.json maps
 *  sessionId → archivedAt (ms). The CLI's sessions.db is never written:
 *  it belongs to `devin` and its schema isn't ours to touch (its `hidden`
 *  column stays a read-only mirror). Archiving only removes a session from
 *  the sidebar's active list — the transcript, search index, direct links
 *  and prompts all keep working. */
import { stateDir } from "./paths.mjs";
import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const archiveFile = () => join(stateDir(), "archive.json");

let cache: Record<string, number> | null = null;

export function archivedMap(): Record<string, number> {
  if (cache) return cache;
  try {
    const raw: unknown = JSON.parse(readFileSync(archiveFile(), "utf8"));
    const out: Record<string, number> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      }
    }
    cache = out;
  } catch {
    cache = {};
  }
  return cache;
}

export function isArchived(sessionId: string): boolean {
  return sessionId in archivedMap();
}

/** Archive (`true`) or restore (`false`) a session. Returns true on success,
 *  null on invalid input or an unwritable state dir. */
export function setArchived(sessionId: string, archived: boolean): true | null {
  if (typeof archived !== "boolean") return null;
  const all = { ...archivedMap() };
  if (archived) all[sessionId] = Date.now();
  else delete all[sessionId];
  try {
    mkdirSync(stateDir(), { recursive: true });
    const tmp = `${archiveFile()}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(all) + "\n", { mode: 0o600 });
    renameSync(tmp, archiveFile());
    cache = all;
  } catch {
    return null;
  }
  return true;
}
