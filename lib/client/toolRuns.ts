import type { ChatItem } from "./model";

/** Presentational grouping for the transcript render loop. Consecutive tool
 *  items (no text/request/plan/notice between them) collapse into one row —
 *  a long turn otherwise renders as a wall of bordered cards. Grouping is
 *  display-only: order, ids and region membership never change. */
export type ToolItem = Extract<ChatItem, { kind: "tool" }>;

export type RenderRow =
  | { type: "item"; item: ChatItem }
  | { type: "group"; id: string; items: ToolItem[] };

export function groupToolRuns(items: ChatItem[], minRun = 3): RenderRow[] {
  const out: RenderRow[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (run.length >= minRun) out.push({ type: "group", id: `tg-${run[0].id}`, items: run });
    else for (const item of run) out.push({ type: "item", item });
    run = [];
  };
  for (const it of items) {
    if (it.kind === "tool") run.push(it);
    else {
      flush();
      out.push({ type: "item", item: it });
    }
  }
  flush();
  return out;
}

/** item id → group id, for expanding the group a jump lands inside */
export function indexToolRuns(rows: RenderRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows)
    if (r.type === "group") for (const it of r.items) m.set(it.id, r.id);
  return m;
}

/** The name the agent reports, else the ACP kind bucket (execute/edit/…). */
export function toolName(t: ToolItem["tool"]): string {
  const m = t._meta;
  if (m && typeof m === "object") {
    const n = (m as Record<string, unknown>)["cognition.ai/inferenceToolName"];
    if (typeof n === "string" && n) return n;
  }
  return t.kind ?? "tool";
}

export function toolRunSummary(items: ToolItem[]) {
  const names = new Map<string, number>();
  let failures = 0;
  let active = false;
  for (const it of items) {
    const n = toolName(it.tool);
    names.set(n, (names.get(n) ?? 0) + 1);
    if (it.tool.status === "failed") failures++;
    if (it.tool.status === "in_progress") active = true;
  }
  const nameSummary = [...names.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
    .join(" · ");
  return { count: items.length, nameSummary, failures, active };
}
