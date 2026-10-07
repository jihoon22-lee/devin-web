"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { GitBranch, X } from "lucide-react";
import { TItem, type TranscriptItem } from "./TranscriptView";

/** Read-only overlay for a history segment or a non-main branch — opened
 *  from the history panel (`?seg=T&base=B` reads one segment's own span,
 *  `?branch=N` resolves to the subtree tip with its context, `?head=N`
 *  walks ancestry). Rows keep their real node ids so a "fork from this
 *  message" action can target any point. */
export default function BranchView({
  sessionId,
  query,
  label,
  onClose,
  onFork,
}: {
  sessionId: string;
  /** transcript query fragment — "head=N" or "branch=N" */
  query: string;
  label: string;
  onClose: () => void;
  onFork: (nodeId: number) => void;
}) {
  const [items, setItems] = useState<TranscriptItem[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // the caller mounts this with key={query} — a new branch selection is a
  // fresh mount, so no synchronous reset belongs in the effect body
  useEffect(() => {
    let dead = false;
    api<{ items: TranscriptItem[]; truncated: boolean }>(
      `/api/sessions/${sessionId}/transcript?${query}&tail=400`,
    )
      .then((r) => {
        if (dead) return;
        setItems(r.items);
        setTruncated(r.truncated);
      })
      .catch((e) => !dead && setErr((e as Error).message));
    return () => {
      dead = true;
    };
  }, [sessionId, query]);

  return (
    <div data-testid="branch-view" className="absolute inset-0 z-20 flex flex-col bg-(--color-bg)">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-(--color-border) bg-(--color-panel)">
        <GitBranch size={13} className="text-(--color-accent) shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">{label}</div>
          <div className="text-tiny text-(--color-faint)">
            earlier history — read-only snapshot
          </div>
        </div>
        <button
          onClick={onClose}
          className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-(--color-panel2) text-xs hover:bg-(--color-panel3) shrink-0"
          aria-label="Back to live transcript"
        >
          <X size={12} /> Back to live
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-4">
        <div className="max-w-3xl mx-auto flex flex-col gap-2.5">
          {truncated && (
            <div className="self-center text-center text-xs text-(--color-faint) px-3 py-1">
              Earlier messages on this branch exist — the tail window is shown.
            </div>
          )}
          {err && <div className="text-(--color-red) text-sm">{err}</div>}
          {items === null && !err && <div className="text-(--color-dim) text-sm">Loading…</div>}
          {items?.map((m, i) => (
            <div key={m.id ?? i} id={m.id != null ? `msg-${m.id}` : undefined} className="group relative">
              <TItem m={m} />
              {m.id != null && (
                <button
                  onClick={() => onFork(m.id!)}
                  className="absolute top-0 right-0 z-10 p-1 rounded-md border border-(--color-border) bg-(--color-panel) text-(--color-dim) opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-white [@media(hover:none)]:opacity-60"
                  title={`Fork the session from this message (node ${m.id})`}
                  aria-label="Fork from this message"
                >
                  <GitBranch size={11} />
                </button>
              )}
            </div>
          ))}
          {items?.length === 0 && <div className="text-(--color-dim) text-sm">Empty branch.</div>}
        </div>
      </div>
    </div>
  );
}
