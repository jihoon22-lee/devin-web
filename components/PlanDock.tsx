"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ListChecks, Play } from "lucide-react";
import type { ChatItem } from "@/lib/client/model";
import { diffPlan, formatRel, planProgress, planSnapshots } from "@/lib/client/plan";
import PlanChecklist, { DiffChips } from "./PlanChecklist";

/** Expanded state persists per session; with nothing stored the bar starts
 *  expanded on precise pointers and collapsed on touch (coarse). */
function initialExpanded(sessionId: string): boolean {
  try {
    const v = localStorage.getItem(`dw-plan-dock:${sessionId}`);
    if (v != null) return v === "1";
  } catch {
    /* no storage */
  }
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return !window.matchMedia("(pointer: coarse)").matches;
    }
  } catch {
    /* matchMedia unavailable (jsdom) */
  }
  return true;
}

/** The plan strip pinned above the status bar — collapsed it shows
 *  progress + the current step; expanded it toggles between the current
 *  checklist and the snapshot history (each row jumps to its card). Mounted
 *  keyed by sessionId so the persisted fold is per session. */
export default function PlanDock({
  items,
  running,
  onJump,
  sessionId,
}: {
  items: ChatItem[];
  running: boolean;
  onJump: (itemId: string) => void;
  sessionId: string;
}) {
  const snapshots = useMemo(() => planSnapshots(items), [items]);
  const [expanded, setExpanded] = useState(() => initialExpanded(sessionId));
  const [tab, setTab] = useState<"current" | "history">("current");

  const latest = snapshots[snapshots.length - 1];
  if (!latest) return null;
  const { done, total, current } = planProgress(latest.entries);
  // an idle session whose plan reached a terminal state needs no dock
  const allDone = latest.entries.every(
    (e) => e.status === "completed" || e.status === "failed",
  );
  if (!running && allDone) return null;

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      localStorage.setItem(`dw-plan-dock:${sessionId}`, next ? "1" : "0");
    } catch {
      /* no storage */
    }
  };

  return (
    <div className="border-t border-(--color-border) bg-(--color-panel)" data-plan-dock>
      <button
        onClick={toggle}
        aria-expanded={expanded}
        title={expanded ? "Collapse plan" : "Expand plan"}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-(--color-panel2)"
      >
        <ListChecks size={13} className="text-(--color-accent) shrink-0" />
        <span className="font-medium shrink-0">
          Plan {done}/{total}
        </span>
        <span className="w-16 sm:w-24 h-1 rounded bg-(--color-panel2) overflow-hidden shrink-0">
          <span
            className="block h-full rounded bg-(--color-accent)"
            style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }}
          />
        </span>
        {current && (
          <span className="flex-1 min-w-0 truncate text-(--color-dim) flex items-center gap-1" title={current.content}>
            {/* ▶ only while the turn runs — after it ends the step is pending, not in-flight */}
            {running && <Play size={9} className="text-(--color-status-running) shrink-0 fill-current" />}
            <span className="truncate">{current.content}</span>
            {!running && <span className="text-(--color-faint) shrink-0">(ended)</span>}
          </span>
        )}
        {!current && <span className="flex-1" />}
        {expanded ? (
          <ChevronDown size={13} className="text-(--color-dim) shrink-0" />
        ) : (
          <ChevronRight size={13} className="text-(--color-dim) shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-(--color-border) max-h-[30vh] md:max-h-[40vh] overflow-y-auto px-3 py-2">
          <div className="flex items-center gap-1 mb-2">
            <button
              onClick={() => setTab("current")}
              className={`px-2 py-0.5 rounded text-2xs ${
                tab === "current"
                  ? "bg-(--color-panel2) text-white"
                  : "text-(--color-dim) hover:text-white"
              }`}
            >
              Current
            </button>
            <button
              onClick={() => setTab("history")}
              className={`px-2 py-0.5 rounded text-2xs ${
                tab === "history"
                  ? "bg-(--color-panel2) text-white"
                  : "text-(--color-dim) hover:text-white"
              }`}
            >
              History ({snapshots.length})
            </button>
          </div>
          {tab === "current" ? (
            <PlanChecklist entries={latest.entries} />
          ) : (
            <div className="flex flex-col gap-1">
              {snapshots
                .map((s, i) => ({ s, i }))
                .reverse()
                .map(({ s, i }) => (
                  <button
                    key={s.key}
                    onClick={() => onJump(s.itemId)}
                    className="dw-plan-row w-full flex items-center gap-2 px-2 py-1 rounded text-left text-xs hover:bg-(--color-panel2)"
                    title="Jump to this plan in the transcript"
                  >
                    <span className="mono text-(--color-faint) shrink-0">#{i}</span>
                    {s.ts != null && (
                      <span className="text-(--color-faint) shrink-0">{formatRel(s.ts)}</span>
                    )}
                    <DiffChips diff={diffPlan(snapshots[i - 1]?.entries ?? null, s.entries)} />
                    {i === snapshots.length - 1 && (
                      <span className="text-tiny text-(--color-green) shrink-0">latest</span>
                    )}
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
