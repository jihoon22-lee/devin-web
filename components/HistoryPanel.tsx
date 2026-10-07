"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { GitBranch, History, RefreshCw } from "lucide-react";

interface SessionSegment {
  base: number;
  tip: number;
  startNodeId: number;
  count: number;
  firstPrompt: string;
  startAt: number | null;
  endAt: number | null;
  isMain: boolean;
  kind: "history" | "branch";
}

/** Work-history timeline — the session's past in readable units: each card
 *  is one compaction-bounded segment (prompt → output, chronological) or an
 *  off-chain alternate branch. Clicking opens just that span's transcript
 *  over the live view; the current work stays on top. */
export default function HistoryPanel({
  sessionId,
  onOpen,
}: {
  sessionId: string;
  /** (transcript query "seg=T&base=B"|"branch=N", human label) */
  onOpen: (query: string, label: string) => void;
}) {
  const [segments, setSegments] = useState<SessionSegment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); // first load is always pending

  const load = useCallback(() => {
    // setLoading(true) lives in the click handler — a synchronous setState
    // inside the mount effect trips react-hooks/set-state-in-effect
    api<{ segments: SessionSegment[] }>(`/api/sessions/${sessionId}/segments`)
      .then((r) => {
        setSegments(r.segments ?? []);
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => {
    setLoading(true);
    load();
  };

  if (err) return <div className="p-3 text-xs text-(--color-red)">History load failed: {err}</div>;
  if (!segments)
    return (
      <div className="p-3 text-xs text-(--color-faint)">{loading ? "Indexing…" : "No data"}</div>
    );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-3 text-sm">
      <div className="flex items-center justify-between px-1">
        <span className="text-2xs uppercase tracking-wide text-(--color-faint)">History</span>
        <button
          onClick={refresh}
          className="p-1 rounded text-(--color-dim) hover:text-white hover:bg-(--color-panel2)"
          title="Refresh"
          aria-label="Refresh history"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {segments.map((s) => {
          const label = s.firstPrompt || "(no user prompt in this segment)";
          const query =
            s.kind === "branch" ? `branch=${s.startNodeId}` : `seg=${s.tip}&base=${s.base}`;
          return (
            <button
              key={`${s.kind}-${s.startNodeId}-${s.tip}`}
              onClick={() => onOpen(query, label)}
              className="text-left rounded-lg border border-(--color-border) bg-(--color-panel) px-3 py-2 hover:bg-(--color-panel2)"
              title={
                s.kind === "branch"
                  ? `alternate continuation from node ${s.base} — opens with context`
                  : `segment nodes ${s.startNodeId}–${s.tip}`
              }
            >
              <span className="flex items-center gap-2 text-2xs text-(--color-faint)">
                {s.isMain ? (
                  <span className="text-(--color-accent) font-medium uppercase tracking-wide">
                    current
                  </span>
                ) : s.kind === "branch" ? (
                  <span className="flex items-center gap-1 text-(--color-dim)">
                    <GitBranch size={10} /> alternate
                  </span>
                ) : (
                  <History size={10} className="shrink-0" />
                )}
                <span>{s.count} nodes</span>
                {s.startAt != null && (
                  <span className="ml-auto">
                    {new Date(s.startAt * 1000).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                )}
              </span>
              <span className="block truncate text-(--color-dim) mt-0.5">{label}</span>
            </button>
          );
        })}
      </div>
      {segments.length === 0 && (
        <div className="text-xs text-(--color-faint) px-1">No history yet.</div>
      )}
    </div>
  );
}
