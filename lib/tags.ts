/** Per-session user tags — stored server-side in $STATE_DIR/tags.json so
 *  the same tags show up on every device (phone, laptop). The CLI's
 *  sessions.db is not touched: it belongs to `devin` and its schema isn't
 *  ours to extend. */
import { stateDir } from "./paths.mjs";
import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const tagsFile = () => join(stateDir(), "tags.json");

const MAX_TAGS = 8;
const MAX_LEN = 24;

let cache: Record<string, string[]> | null = null;

/** Normalize arbitrary input into a tag list. `null` = input wasn't an
 *  array of strings (caller should 400). Over-long/over-many entries are
 *  truncated rather than rejected — the UI never produces them anyway. */
export function normalizeTags(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.some((t) => typeof t !== "string")) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input as string[]) {
    const t = raw.trim().replace(/^#+/, "").replace(/\s+/g, " ").slice(0, MAX_LEN);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export function allTags(): Record<string, string[]> {
  if (cache) return cache;
  try {
    const raw: unknown = JSON.parse(readFileSync(tagsFile(), "utf8"));
    const out: Record<string, string[]> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const t = normalizeTags(v);
        if (t && t.length) out[k] = t;
      }
    }
    cache = out;
  } catch {
    cache = {};
  }
  return cache;
}

export function sessionTags(sessionId: string): string[] {
  return allTags()[sessionId] ?? [];
}

/** Replace a session's tags; empty list removes the entry. Returns the
 *  stored list, or null when `tags` failed validation. */
export function setSessionTags(sessionId: string, tags: unknown): string[] | null {
  const norm = normalizeTags(tags);
  if (!norm) return null;
  const all = { ...allTags() };
  if (norm.length) all[sessionId] = norm;
  else delete all[sessionId];
  try {
    mkdirSync(stateDir(), { recursive: true });
    const tmp = `${tagsFile()}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(all) + "\n", { mode: 0o600 });
    renameSync(tmp, tagsFile());
    cache = all;
  } catch {
    return null; // unwritable state dir — report failure rather than pretend
  }
  return norm;
}
