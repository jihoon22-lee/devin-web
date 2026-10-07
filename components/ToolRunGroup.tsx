"use client";

import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, Loader2, TriangleAlert, Wrench } from "lucide-react";
import type { ChatItem } from "@/lib/client/model";
import { toolRunSummary } from "@/lib/client/toolRuns";

/** Collapsible summary of a consecutive run of tool calls. Children stay
 *  mounted while collapsed — msg-<id> anchors, ItemBoundary wrappers and
 *  durable-node positions must remain in the DOM for search jumps and
 *  retained-region bookkeeping. */
export default function ToolRunGroup({
  items,
  open,
  onToggle,
  children,
}: {
  items: Extract<ChatItem, { kind: "tool" }>[];
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const s = toolRunSummary(items);
  return (
    <div className="rounded-lg border border-(--color-border) bg-(--color-panel)/50 overflow-hidden">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-(--color-panel2)"
      >
        <Wrench size={12} className="text-(--color-faint) shrink-0" />
        <span className="text-(--color-text) shrink-0">{s.count} tool calls</span>
        <span className="text-(--color-faint) truncate flex-1 min-w-0">{s.nameSummary}</span>
        {s.failures > 0 && (
          <span className="flex items-center gap-1 text-(--color-red) shrink-0">
            <TriangleAlert size={11} />
            {s.failures} failed
          </span>
        )}
        {s.active && <Loader2 size={11} className="text-(--color-accent) animate-spin shrink-0" />}
        {open ? (
          <ChevronDown size={12} className="text-(--color-faint) shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-(--color-faint) shrink-0" />
        )}
      </button>
      <div hidden={!open} className="border-t border-(--color-border) px-2 py-2 flex flex-col gap-2">
        {children}
      </div>
    </div>
  );
}
