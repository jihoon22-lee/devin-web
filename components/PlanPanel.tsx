"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ChatItem } from "@/lib/client/model";
import type { PlanEntry } from "@/lib/acp/types";
import { diffPlan, formatRel, planSnapshots, type PlanSnapshot } from "@/lib/client/plan";
import PlanChecklist, { DiffChips } from "./PlanChecklist";

function SnapRow({
  snap,
  index,
  latest,
  prev,
  onJump,
}: {
  snap: PlanSnapshot;
  index: number;
  latest: boolean;
  prev: PlanEntry[] | null;
  onJump: () => void;
}) {
  const [open, setOpen] = useState(latest);
  return (
    <div className="rounded-lg border border-(--color-border) bg-(--color-panel)">
      <div className="flex items-center gap-1 px-2 py-1.5 text-xs">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Collapse snapshot" : "Expand snapshot"}
          title={open ? "Collapse snapshot" : "Expand snapshot"}
          className="p-0.5 rounded text-(--color-dim) hover:text-white shrink-0"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <button
          onClick={onJump}
          className="dw-plan-row flex-1 min-w-0 flex items-center gap-2 text-left"
          title="Jump to this plan in the transcript"
        >
          <span className="mono text-(--color-faint) shrink-0">#{index}</span>
          <span
            className={`text-tiny px-1 rounded border shrink-0 ${
              snap.source === "live"
                ? "text-(--color-accent) border-(--color-accent)/40"
                : "text-(--color-dim) border-(--color-border)"
            }`}
          >
            {snap.source === "live" ? "live" : "saved"}
          </span>
          {latest && <span className="text-tiny text-(--color-green) shrink-0">latest</span>}
          {snap.ts != null && (
            <span className="text-(--color-faint) shrink-0">{formatRel(snap.ts)}</span>
          )}
          <DiffChips diff={diffPlan(prev, snap.entries)} />
        </button>
      </div>
      {open && (
        <div className="px-3 pb-2">
          <PlanChecklist entries={snap.entries} />
        </div>
      )}
    </div>
  );
}

/** Plan side panel — the full snapshot timeline, newest first. Rows jump to
 *  the card that produced the snapshot (and return to the chat tab, which the
 *  panel covers on mobile). */
export default function PlanPanel({
  items,
  historyTruncated,
  loadingOlder,
  onLoadOlder,
  onJump,
  onOpenChat,
}: {
  items: ChatItem[];
  historyTruncated: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onJump: (itemId: string) => void;
  onOpenChat: () => void;
}) {
  const snapshots = useMemo(() => planSnapshots(items), [items]);
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1.5 text-sm">
      <div className="px-1 text-2xs uppercase tracking-wide text-(--color-faint)">
        Plan timeline
      </div>
      {snapshots.length === 0 && (
        <div className="text-xs text-(--color-faint) px-1">No plan snapshots yet.</div>
      )}
      {snapshots
        .map((s, i) => ({ s, i }))
        .reverse()
        .map(({ s, i }) => (
          <SnapRow
            key={s.key}
            snap={s}
            index={i}
            latest={i === snapshots.length - 1}
            prev={snapshots[i - 1]?.entries ?? null}
            onJump={() => {
              onJump(s.itemId);
              onOpenChat();
            }}
          />
        ))}
      {historyTruncated && (
        <button
          onClick={onLoadOlder}
          disabled={loadingOlder}
          className="self-center text-xs text-(--color-dim) hover:text-white px-3 py-1 rounded-full border border-(--color-border) hover:bg-(--color-panel2) disabled:opacity-50"
        >
          {loadingOlder ? "Loading…" : "Load earlier messages"}
        </button>
      )}
    </div>
  );
}
