"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { ChatItem } from "@/lib/client/model";
import type { useSessionView } from "@/hooks/useSessionView";

type ViewState = ReturnType<typeof useSessionView>["state"];

/** What's Devin doing right now — derived from the tail of the item stream. */
function activityOf(items: ChatItem[]): { label: string; waiting: boolean } {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "request" && !it.resolved) {
      return {
        label: it.method === "session/request_permission" ? "needs permission" : "needs your input",
        waiting: true,
      };
    }
    if (it.kind === "tool" && it.tool.status === "in_progress") {
      return { label: it.tool.title || "running a tool", waiting: false };
    }
    if (it.kind === "text" && !it.done) {
      return { label: it.role === "thought" ? "thinking" : "writing", waiting: false };
    }
  }
  return { label: "working", waiting: false };
}

function Elapsed({ since }: { since?: number }) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    queueMicrotask(() => setNow(Date.now()));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!since) return null;
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const mm = Math.floor(s / 60);
  // aria-hidden: a per-second ticker must never be announced by live regions
  return <span aria-hidden="true" className="mono shrink-0">{mm > 0 ? `${mm}m ${s % 60}s` : `${s}s`}</span>;
}

/** Persistent activity status — pinned below the transcript while a turn
 *  runs or prompts are queued, visible regardless of scroll position. */
export default function StatusBar({
  state,
  items,
  bypass = false,
  onEditQueued,
  onDropQueued,
  onSendQueued,
}: {
  state: ViewState;
  items: ChatItem[];
  /** bypass-permissions mode — the pulse dot turns red as a warning */
  bypass?: boolean;
  onEditQueued: (id: string) => void;
  onDropQueued: (id: string) => void;
  onSendQueued: (id: string) => void;
}) {
  const { label, waiting } = activityOf(items);
  const [showQueue, setShowQueue] = useState(false);
  const queued = state.queueItems ?? [];
  // role=status stays on the bar (state word, activity label, queue count
  // are all announcement-worthy) — the per-second Elapsed ticker is
  // aria-hidden so it alone can't spam the live region
  return (
    <div
      role="status"
      className={`border-t px-3 py-1.5 flex items-center gap-2.5 text-2xs ${
        waiting
          ? "border-(--color-status-input)/50 bg-(--color-status-input)/10 text-(--color-status-input)"
          : "border-(--color-border) bg-(--color-panel)/60 text-(--color-dim)"
      }`}
    >
      <span
        aria-hidden="true"
        className={`w-1.5 h-1.5 rounded-full animate-pulse shrink-0 ${
          waiting ? "bg-(--color-status-input)" : bypass ? "bg-(--color-danger)" : "bg-(--color-status-running)"
        }`}
      />
      <span className="font-medium shrink-0">{waiting ? "Waiting" : "Working"}</span>
      <Elapsed since={state.runningSince} />
      <span className="truncate flex-1 min-w-0" title={label}>
        {/* the bare "working" fallback just repeats the status word — only
            show the label when it carries real detail; the in-progress plan
            step already lives in PlanDock right above */}
        {waiting || label !== "working" ? label : ""}
      </span>
      {state.queued > 0 && (
        <span className="relative shrink-0">
          <button
            onClick={() => setShowQueue((v) => !v)}
            className="hover:text-white"
            title={`${state.queued} prompt(s) queued — click to manage`}
          >
            +{state.queued} queued
          </button>
          {showQueue && (
            <div className="absolute bottom-6 right-0 w-72 max-w-[80vw] rounded-xl border border-(--color-border2) bg-(--color-panel2) shadow-2xl p-1 dw-pop z-30">
              <div className="px-2 py-1 text-tiny text-(--color-faint)">Queued prompts</div>
              {queued.length === 0 && (
                <div className="px-2 py-2 text-xs text-(--color-dim)">{state.queued} prompt(s) waiting</div>
              )}
              {queued.map((q) => (
                <div key={q.id} className="flex items-center gap-1 px-2 py-1.5 rounded hover:bg-(--color-panel3)">
                  <span className="flex-1 min-w-0 truncate text-xs text-(--color-text)" title={q.text}>
                    {q.text}
                  </span>
                  {state.running && (
                    <button
                      className="text-tiny text-(--color-accent) hover:underline shrink-0"
                      title="Send now — steers the running turn at its next step, without stopping the current tool"
                      onClick={() => onSendQueued(q.id)}
                    >
                      send now
                    </button>
                  )}
                  <button
                    className="text-tiny text-(--color-dim) hover:text-(--color-accent) hover:underline shrink-0"
                    title="Move back into the input to edit"
                    onClick={() => {
                      setShowQueue(false);
                      onEditQueued(q.id);
                    }}
                  >
                    edit
                  </button>
                  <button
                    className="text-(--color-dim) hover:text-(--color-danger) shrink-0"
                    title="Drop this queued prompt"
                    aria-label="Drop queued prompt"
                    onClick={() => onDropQueued(q.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  );
}
