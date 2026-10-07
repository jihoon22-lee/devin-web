// Pure plan-snapshot helpers — shared by the transcript cards, the dock and
// the side panel. No React here: unit tests import this module directly.
//
// A plan surfaces through three shapes:
//   todo  — durable todo_write tool rows (tool.rawInput.todos); the durable
//           history after the turn flips
//   live  — the running turn's in-place plan card; each bounded `revisions`
//           entry is one snapshot of how the plan evolved
//   card  — a retained/durable plan card with no revision trail; only shown
//           when no todo_write row covers the history (otherwise it doubles)
import type { PlanEntry, ToolCallUpdate } from "@/lib/acp/types";
import type { ChatItem } from "@/lib/client/model";

export interface PlanSnapshot {
  /** unique within one pass — revision suffix `#r<i>` for expanded cards */
  key: string;
  /** the ChatItem this snapshot came from — jump target + diff map key */
  itemId: string;
  entries: PlanEntry[];
  source: "todo" | "live" | "card";
  /** epoch ms when known (durable row ts or assembler event ts) */
  ts?: number;
  /** durable node_id for bf- tool rows */
  nodeId?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** A todo_write tool call's full plan array — the durable record of a plan
 *  revision. Strict shape: every todo must be an object with string content,
 *  or the whole call doesn't count (a half-parsed plan is worse than none). */
export function todoEntries(tool: ToolCallUpdate | undefined): PlanEntry[] | null {
  if (!tool) return null;
  const meta = isObj(tool._meta) ? tool._meta : null;
  if (meta?.["cognition.ai/inferenceToolName"] !== "todo_write") return null;
  const raw = isObj(tool.rawInput) ? tool.rawInput : null;
  if (!Array.isArray(raw?.todos)) return null;
  const out: PlanEntry[] = [];
  for (const t of raw.todos as unknown[]) {
    if (!isObj(t) || typeof t.content !== "string") return null;
    out.push({
      content: t.content,
      ...(typeof t.status === "string" ? { status: t.status } : {}),
      ...(typeof t.priority === "string" ? { priority: t.priority } : {}),
    });
  }
  return out;
}

/** Same rendered plan? Compares the fields the UI renders (content, status,
 *  priority) — identical consecutive snapshots collapse into one. */
export function entriesEqual(a: PlanEntry[], b: PlanEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (e, i) =>
        e.content === b[i].content &&
        e.status === b[i].status &&
        e.priority === b[i].priority,
    )
  );
}

/** Walk the rendered item list and extract every plan snapshot in display
 *  order. Provisional plan cards expand their bounded revision trail;
 *  retained/durable cards are a fallback shape and drop out entirely once a
 *  todo_write row exists anywhere (the durable rows are the history). Runs of
 *  identical snapshots dedupe — a plan re-sent unchanged isn't a new step. */
export function planSnapshots(items: ChatItem[]): PlanSnapshot[] {
  const out: PlanSnapshot[] = [];
  let hasTodo = false;
  for (const item of items) {
    if (item.kind === "tool") {
      const entries = todoEntries(item.tool);
      if (entries) {
        hasTodo = true;
        out.push({
          key: `t:${item.id}`,
          itemId: item.id,
          entries,
          source: "todo",
          ts: item.ts,
          nodeId: Number(item.id.slice(3)) || undefined,
        });
      }
      continue;
    }
    if (item.kind !== "plan") continue;
    // provisional = assembled live card (p- id, no durable anchor); retained
    // and durable plan rows render from stored history only
    const provisional = item.anchor == null && !item.id.startsWith("bf-");
    if (provisional) {
      const revs = item.revisions ?? [];
      if (revs.length) {
        revs.forEach((rev, i) => {
          out.push({
            key: `${item.id}#r${i}`,
            itemId: item.id,
            entries: rev.entries,
            source: "live",
            ts: rev.ts,
          });
        });
      } else {
        out.push({ key: `p:${item.id}`, itemId: item.id, entries: item.entries, source: "live" });
      }
      continue;
    }
    out.push({ key: `c:${item.id}`, itemId: item.id, entries: item.entries, source: "card" });
  }
  const list = hasTodo ? out.filter((s) => s.source !== "card") : out;
  const deduped: PlanSnapshot[] = [];
  for (const s of list) {
    const last = deduped[deduped.length - 1];
    if (last && entriesEqual(last.entries, s.entries)) continue;
    deduped.push(s);
  }
  return deduped;
}

export interface PlanDiff {
  completed: string[];
  started: string[];
  added: string[];
  removed: string[];
}

/** Display-only diff between two plan snapshots, matched by entry content.
 *  A new entry whose first sighting is already "completed" counts as added,
 *  not completed — it never visibly transitioned. */
export function diffPlan(prev: PlanEntry[] | null, next: PlanEntry[]): PlanDiff {
  const d: PlanDiff = { completed: [], started: [], added: [], removed: [] };
  const prevBy = new Map<string, PlanEntry>();
  for (const e of prev ?? []) prevBy.set(e.content, e);
  for (const e of next) {
    const p = prevBy.get(e.content);
    if (!p) {
      d.added.push(e.content);
      continue;
    }
    if (e.status === p.status) continue;
    if (e.status === "completed") d.completed.push(e.content);
    else if (e.status === "in_progress") d.started.push(e.content);
  }
  const nextSet = new Set(next.map((e) => e.content));
  for (const e of prev ?? []) {
    if (!nextSet.has(e.content)) d.removed.push(e.content);
  }
  return d;
}

/** `done` counts only completed entries; `current` is the first in_progress. */
export function planProgress(entries: PlanEntry[]): {
  done: number;
  total: number;
  current?: PlanEntry;
} {
  return {
    done: entries.filter((e) => e.status === "completed").length,
    total: entries.length,
    current: entries.find((e) => e.status === "in_progress"),
  };
}

/** Compact relative age for snapshot rows — "12s ago", "3m ago", "2h ago". */
export function formatRel(ts: number | undefined, now = Date.now()): string {
  if (ts == null || !Number.isFinite(ts)) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
