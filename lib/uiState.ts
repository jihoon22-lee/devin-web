/** Sidebar UI state that should follow the user across devices — pins and
 *  collapsed project groups (tags already live server-side, lib/tags.ts).
 *  $STATE_DIR/ui-state.json, atomic 0600 writes, bounded lists. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { stateDir } from "./paths.mjs";
import { join } from "node:path";

const stateFile = () => join(stateDir(), "ui-state.json");
const MAX_ITEMS = 500;

export interface UiState {
  pins: string[];
  collapsed: string[];
  /** config-option values applied to every new session (whitelisted —
   *  `mode` is deliberately absent so Bypass can't leak into new sessions) */
  sessionDefaults?: Record<string, string>;
  /** reusable prompt snippets — offered in the composer's `/` palette */
  snippets?: Snippet[];
  /** daily output-token budget; a toast fires once a day when crossed */
  budget?: { dailyOutputTokens: number };
}

export interface Snippet {
  id: string;
  name: string;
  text: string;
}

const MAX_SNIPPETS = 100;

/** null = invalid. Names ≤60 chars, bodies ≤8000, ids ≤40, unique ids. */
const snippetList = (v: unknown): Snippet[] | null => {
  if (!Array.isArray(v) || v.length > MAX_SNIPPETS) return null;
  const out: Snippet[] = [];
  const ids = new Set<string>();
  for (const x of v) {
    const o = x as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return null;
    const { id, name, text } = o;
    if (typeof id !== "string" || !id || id.length > 40 || ids.has(id)) return null;
    if (typeof name !== "string" || !name.trim() || name.length > 60) return null;
    if (typeof text !== "string" || !text.trim() || text.length > 8000) return null;
    ids.add(id);
    out.push({ id, name: name.trim(), text });
  }
  return out;
};

const budgetOf = (v: unknown): { dailyOutputTokens: number } | null | undefined => {
  if (v === null) return undefined; // explicit clear
  const n = (v as { dailyOutputTokens?: unknown } | undefined)?.dailyOutputTokens;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 1e10 ? { dailyOutputTokens: n } : null;
};

let cache: UiState | null = null;

const list = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? [...new Set(v as string[])].slice(0, MAX_ITEMS) : null;

const SESSION_DEFAULT_KEYS = new Set(["model", "thought_level", "speed"]);

/** Strict whitelist: only known config ids with non-empty string values
 *  ≤200 chars. null = invalid input (the caller answers 400). */
const sessionDefaults = (v: unknown): Record<string, string> | null => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!SESSION_DEFAULT_KEYS.has(k)) return null;
    if (typeof x !== "string" || x.length === 0 || x.length > 200) return null;
    out[k] = x;
  }
  return out;
};

export function uiState(): UiState {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as Record<string, unknown>;
    const sd = raw.sessionDefaults != null ? sessionDefaults(raw.sessionDefaults) : null;
    const sn = raw.snippets != null ? snippetList(raw.snippets) : null;
    const bg = raw.budget != null ? budgetOf(raw.budget) : null;
    cache = {
      pins: list(raw.pins) ?? [],
      collapsed: list(raw.collapsed) ?? [],
      // a corrupt persisted map degrades to "no defaults", never to a crash
      ...(sd && Object.keys(sd).length ? { sessionDefaults: sd } : {}),
      ...(sn && sn.length ? { snippets: sn } : {}),
      ...(bg ? { budget: bg } : {}),
    };
  } catch {
    cache = { pins: [], collapsed: [] };
  }
  return cache;
}

/** Replace only the fields present in `patch` — except sessionDefaults,
 *  whose keys MERGE into the stored map (clients send only the key that
 *  changed). null = invalid input or an unwritable state dir (the caller
 *  answers 400/500, never pretends). */
export function updateUiState(patch: Record<string, unknown>): UiState | null {
  const next: UiState = { ...uiState() };
  for (const k of ["pins", "collapsed"] as const) {
    if (!(k in patch)) continue;
    const v = list(patch[k]);
    if (!v) return null;
    next[k] = v;
  }
  if ("sessionDefaults" in patch) {
    const d = sessionDefaults(patch.sessionDefaults);
    if (!d) return null;
    next.sessionDefaults = { ...(next.sessionDefaults ?? {}), ...d };
  }
  if ("snippets" in patch) {
    const sn = snippetList(patch.snippets);
    if (!sn) return null;
    if (sn.length) next.snippets = sn;
    else delete next.snippets;
  }
  if ("budget" in patch) {
    const b = budgetOf(patch.budget);
    if (b === null) return null;
    if (b) next.budget = b;
    else delete next.budget;
  }
  try {
    mkdirSync(stateDir(), { recursive: true });
    const tmp = `${stateFile()}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
    renameSync(tmp, stateFile());
  } catch {
    return null;
  }
  cache = next;
  return next;
}
