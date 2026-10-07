// Pure helpers for the session config bar (components/ConfigBar.tsx).
// The agent exposes SessionConfigOption[] — mode/model/thought_level get
// dedicated UI, everything else renders generically from `extra`.
import { Code, FileText, MessageCircle, ShieldOff, Sparkles, type LucideIcon } from "lucide-react";
import type { SessionConfigOption } from "@/lib/acp/types";

export interface ClassifiedConfig {
  mode?: SessionConfigOption;
  model?: SessionConfigOption;
  thought?: SessionConfigOption;
  /** speed (category "model_config"), booleans, anything unrecognised */
  extra: SessionConfigOption[];
}

const kindOf = (o: SessionConfigOption): "mode" | "model" | "thought" | null =>
  o.id === "mode" || o.category === "mode"
    ? "mode"
    : o.id === "model" || o.category === "model"
      ? "model"
      : o.id === "thought_level" || o.category === "thought_level"
        ? "thought"
        : null;

/** Split configOptions into the dedicated controls + the generic extras.
 *  First match wins; duplicates fall through to `extra`. */
export function classifyConfig(opts?: SessionConfigOption[] | null): ClassifiedConfig {
  const out: ClassifiedConfig = { extra: [] };
  for (const o of opts ?? []) {
    const k = kindOf(o);
    if (k === "mode" && !out.mode) out.mode = o;
    else if (k === "model" && !out.model) out.model = o;
    else if (k === "thought" && !out.thought) out.thought = o;
    else out.extra.push(o);
  }
  return out;
}

const GROUP_PREFIXES: [string, string][] = [
  ["fusion-", "Fusion"],
  ["claude-", "Claude"],
  ["gpt-", "GPT"],
  ["gemini-", "Gemini"],
  ["swe-", "SWE"],
  ["grok-", "Grok"],
  ["glm-", "GLM"],
  ["deepseek-", "DeepSeek"],
  ["kimi-", "Kimi"],
];

/** Display-only group label for the model picker — a bare value prefix map
 *  ("adaptive" and unrecognised ids land in "Other"). */
export function modelGroup(value: string): string {
  for (const [prefix, group] of GROUP_PREFIXES) {
    if (value.startsWith(prefix)) return group;
  }
  return "Other";
}

/** Per-model image support flag — `_meta["cognition.ai/supportsImages"]` is
 *  untyped, so anything but a real boolean reports "unknown" (undefined). */
export function optionSupportsImages(opt: SessionConfigOption, value: string): boolean | undefined {
  const v = opt.options?.find((o) => o.value === value)?._meta?.["cognition.ai/supportsImages"];
  return typeof v === "boolean" ? v : undefined;
}

export const MODE_ICONS: Record<string, LucideIcon> = {
  code: Code,
  sparkles: Sparkles,
  "message-circle": MessageCircle,
  "file-text": FileText,
  "shield-off": ShieldOff,
};

/** Mode option → its lucide icon (`_meta["cognition.ai/icon"]`), if known. */
export function modeIcon(opt: { _meta?: Record<string, unknown> | null } | undefined | null): LucideIcon | undefined {
  const name = opt?._meta?.["cognition.ai/icon"];
  return typeof name === "string" ? MODE_ICONS[name] : undefined;
}

const RECENT_KEY = "dw-recent-models";
const RECENT_MAX = 5;

/** Most-recently-used model values, newest first (localStorage, bounded). */
export function loadRecentModels(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v)
      ? (v.filter((x) => typeof x === "string") as string[]).slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

export function pushRecentModel(value: string): void {
  try {
    const next = [value, ...loadRecentModels().filter((x) => x !== value)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
}

/** Option display name for a value (chip labels) — falls back to the raw
 *  value when it isn't in the option list. */
export function shortModelName(opt: SessionConfigOption | undefined | null, value: string): string {
  return opt?.options?.find((o) => o.value === value)?.name ?? value;
}

const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;

/** Effort tier encoded in a model value's trailing -<tier> suffix
 *  ("swe-2-high" → "high"). Undefined when the display name already
 *  mentions it — fusion names carry both lead and sidekick tiers. */
export function modelEffortTag(value: string, name?: string): string | undefined {
  const m = EFFORT_SUFFIX.exec(value);
  if (!m || name?.toLowerCase().includes(m[1])) return undefined;
  return m[1];
}
