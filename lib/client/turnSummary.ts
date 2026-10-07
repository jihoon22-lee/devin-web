import type { ChatItem } from "./model";

export interface TurnSummary {
  /** first user message → last timestamped item of the turn; null when the
   *  rows carry no times */
  ms: number | null;
  tools: number;
  edits: number;
}

/** One summary per finished durable turn, keyed by the id of the turn's
 *  last item (the footer renders after it). A turn runs from a user
 *  message to the next one; the trailing turn counts only when `finished`
 *  (no turn is running). Live (provisional) turns are skipped — the status
 *  bar already shows their elapsed time. */
export function turnSummaries(items: ChatItem[], finished: boolean): Map<string, TurnSummary> {
  const out = new Map<string, TurnSummary>();
  let start: number | null = null;
  let userTs: number | undefined;
  const close = (end: number) => {
    if (start === null || end <= start) return;
    const turn = items.slice(start, end);
    if (!turn[0].id.startsWith("bf-")) return;
    let tools = 0;
    let edits = 0;
    let last: number | undefined;
    for (const it of turn) {
      if (it.kind === "tool") {
        tools++;
        if (it.tool.kind === "edit") edits++;
        if (typeof it.ts === "number") last = Math.max(last ?? 0, it.ts);
      } else if (it.kind === "text" && typeof it.ts === "number") last = Math.max(last ?? 0, it.ts);
    }
    // a turn that is just a question and a one-line answer needs no footer
    if (turn.length < 3 && !tools) return;
    const ms = userTs !== undefined && last !== undefined && last > userTs ? last - userTs : null;
    out.set(turn[turn.length - 1].id, { ms, tools, edits });
  };
  items.forEach((it, i) => {
    if (it.kind === "text" && it.role === "user") {
      close(i);
      start = i;
      userTs = it.ts;
    }
  });
  if (finished) close(items.length);
  return out;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "14:05" today, "10/3 14:05" otherwise. */
export function fmtMessageTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
