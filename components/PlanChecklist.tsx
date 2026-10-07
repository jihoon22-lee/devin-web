"use client";

import { CircleCheck, CircleDashed, CircleX, Minus, Play, Plus } from "lucide-react";
import type { PlanEntry } from "@/lib/acp/types";
import type { PlanDiff } from "@/lib/client/plan";

const chipTitle = (items: string[]) => items.join("\n").slice(0, 200);

/** Compact transition chips — completed, started, added, removed.
 *  Purely a display diff (entries are matched by content, never by identity —
 *  the wire gives plan entries no ids). */
export function DiffChips({ diff }: { diff?: PlanDiff | null }) {
  if (!diff) return null;
  const chips = [
    {
      key: "completed",
      icon: <CircleCheck size={9} />,
      items: diff.completed,
      cls: "text-(--color-green) border-(--color-green)/40 bg-(--color-green)/10",
      label: "completed",
    },
    {
      key: "started",
      icon: <Play size={9} className="fill-current" />,
      items: diff.started,
      cls: "text-(--color-status-running) border-(--color-status-running)/40 bg-(--color-status-running)/10",
      label: "started",
    },
    {
      key: "added",
      icon: <Plus size={9} />,
      items: diff.added,
      cls: "text-(--color-accent) border-(--color-accent)/40 bg-(--color-accent)/10",
      label: "added",
    },
    {
      key: "removed",
      icon: <Minus size={9} />,
      items: diff.removed,
      cls: "text-(--color-red) border-(--color-red)/40 bg-(--color-red)/10",
      label: "removed",
    },
  ].filter((c) => c.items.length > 0);
  if (!chips.length) return null;
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      {chips.map((c) => (
        <span
          key={c.key}
          title={`${c.label}:\n${chipTitle(c.items)}`}
          className={`mono text-tiny leading-4 px-1 rounded border inline-flex items-center gap-0.5 ${c.cls}`}
        >
          {c.icon}
          {c.items.length}
        </span>
      ))}
    </span>
  );
}

function entryIcon(status?: string) {
  switch (status) {
    case "completed":
      return <CircleCheck size={13} className="text-(--color-green)" />;
    case "failed":
      return <CircleX size={13} className="text-(--color-red)" />;
    case "in_progress":
      return <CircleDashed size={13} className="text-(--color-status-running)" />;
    default:
      return <CircleDashed size={13} className="text-(--color-dim)" />;
  }
}

/** The plan's checklist body — the same rows whether the source is a live
 *  plan card, a durable todo_write row or the dock/panel timeline. */
export default function PlanChecklist({
  entries,
  diff,
}: {
  entries: PlanEntry[];
  diff?: PlanDiff | null;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {diff && <DiffChips diff={diff} />}
      <ul className="flex flex-col gap-1">
        {entries.map((e, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 shrink-0">{entryIcon(e.status)}</span>
            <span className={e.status === "completed" ? "line-through text-(--color-dim)" : ""}>
              {e.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
