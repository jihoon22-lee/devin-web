"use client";

import { Component, memo, useContext, useState, type ReactNode } from "react";
import Markdown from "./Markdown";
import ToolContent from "./ToolContent";
import {
  AlertCircle, Brain, ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleX,
  FileText, Globe, ListChecks, Pencil, Search, TerminalSquare, Trash2, Wrench, X,
} from "lucide-react";
import type { ChatItem } from "@/lib/client/model";
import { dismissNotice } from "@/lib/client/api";
import type { ToolCallUpdate } from "@/lib/acp/types";
import { diffPlan, planProgress, todoEntries } from "@/lib/client/plan";
import PlanChecklist, { DiffChips } from "./PlanChecklist";
import { PlanMetaCtx, ThoughtExpandCtx } from "./PlanMetaCtx";
import PermissionCard from "./PermissionCard";
import { fmtMessageTime } from "@/lib/client/turnSummary";
import ElicitationCard from "./ElicitationCard";

const KIND_ICON: Record<string, React.ReactNode> = {
  execute: <TerminalSquare size={14} />,
  read: <FileText size={14} />,
  edit: <Pencil size={14} />,
  delete: <Trash2 size={14} />,
  move: <Pencil size={14} />,
  search: <Search size={14} />,
  fetch: <Globe size={14} />,
  think: <Brain size={14} />,
  switch_mode: <ListChecks size={14} />,
  other: <Wrench size={14} />,
};

/** memo skips unchanged items: durable rows keep identity through
 *  mergeDurable, and provisional/retained items through applyItemsFrame's
 *  itemRev reuse — only the item that actually changed re-renders. */
const MessageItem = memo(function MessageItem({ item, sessionId }: { item: ChatItem; sessionId: string }) {
  switch (item.kind) {
    case "text":
      return <TextItem item={item} />;
    case "tool":
      // durable todo_write rows ARE plan revisions — render the checklist
      // card, not a generic wrench
      return todoEntries(item.tool) ? (
        <PlanUpdateCard item={item} />
      ) : (
        <ToolCard tool={item.tool} />
      );
    case "plan":
      return <PlanItem item={item} />;
    case "request":
      return item.method === "session/request_permission" ? (
        <PermissionCard item={item} sessionId={sessionId} />
      ) : (
        <ElicitationCard item={item} sessionId={sessionId} />
      );
    case "notice":
      return <NoticeItem item={item} sessionId={sessionId} />;
  }
});
export default MessageItem;

/** Overlay notice (turn_error / one-off notice). Server-authoritative — the
 *  dismiss goes through the API so every connected view drops it together. */
function NoticeItem({ item, sessionId }: { item: Extract<ChatItem, { kind: "notice" }>; sessionId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div
      role="alert"
      className="flex items-start gap-2 px-2 py-1.5 text-(--color-red) text-sm"
    >
      <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-keep wrap-anywhere">{item.text}</div>
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          dismissNotice(sessionId, item.id).catch(() => setBusy(false));
        }}
        className="shrink-0 rounded p-1 text-(--color-faint) hover:text-(--color-fg) hover:bg-(--color-panel2) disabled:opacity-50"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

/** A single malformed item must not unmount the whole transcript — render
 *  an inline marker instead of letting the error take down the page. */
export class ItemBoundary extends Component<
  { children: ReactNode },
  { err: boolean }
> {
  state = { err: false };
  static getDerivedStateFromError() {
    return { err: true };
  }
  render() {
    return this.state.err ? (
      <div className="text-(--color-faint) text-xs px-2 py-1">[item failed to render]</div>
    ) : (
      this.props.children
    );
  }
}

function TextItem({ item }: { item: Extract<ChatItem, { kind: "text" }> }) {
  const [open, setOpen] = useState(false);
  const expandAll = useContext(ThoughtExpandCtx);
  if (item.role === "user") {
    return (
      <div className="self-end max-w-[85%] bg-(--color-accent)/15 border border-(--color-accent)/30 rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-keep wrap-anywhere">
        {item.mentions && item.mentions.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1">
            {item.mentions.map((m) => (
              <span key={m.path} className="mono text-tiny bg-(--color-accent)/25 rounded px-1.5 py-0.5" title={m.path}>
                @{m.name}
              </span>
            ))}
          </div>
        )}
        {item.text}
        {typeof item.ts === "number" && (
          <time
            dateTime={new Date(item.ts).toISOString()}
            className="block text-right text-tiny text-(--color-faint) mt-0.5 -mb-0.5"
          >
            {fmtMessageTime(item.ts)}
          </time>
        )}
      </div>
    );
  }
  if (item.role === "thought") {
    // "Expand all thoughts" forces every block open; the chevron still
    // tracks the per-item toggle for when the global flag flips back off
    const shown = expandAll || open;
    const len = item.text.length;
    // collapsed: the first line says what the thought was about
    const preview = shown ? "" : thoughtPreview(item.text);
    return (
      <div className="border-l-2 border-(--color-border) pl-3">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={shown}
          className="flex items-center gap-1 w-full min-w-0 py-0.5 text-xs text-(--color-dim) italic hover:text-white text-left"
        >
          {shown ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
          <span className="shrink-0">{item.done ? "thought" : "thinking"}</span>
          {!item.done && <span className="inline-block w-1.5 h-1.5 rounded-full bg-(--color-dim) animate-pulse shrink-0" />}
          {preview && <span className="truncate not-italic text-(--color-faint) min-w-0">— {preview}</span>}
          <span className="ml-auto pl-1 mono not-italic text-tiny text-(--color-faint) shrink-0">
            {len > 999 ? `${(len / 1000).toFixed(1)}k` : len} chars
          </span>
        </button>
        {shown && (
          <div className="text-xs text-(--color-dim) italic whitespace-pre-wrap mt-1">{item.text}</div>
        )}
      </div>
    );
  }
  return (
    <div className="text-sm leading-relaxed min-w-0">
      <Markdown>{item.text}</Markdown>
      {!item.done && <span className="inline-block w-1.5 h-3.5 bg-(--color-accent) animate-pulse align-text-bottom" />}
    </div>
  );
}

/** First meaningful line of a thought, markdown emphasis stripped. */
export function thoughtPreview(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.replace(/(\*\*|__|`)/g, "").replace(/^#+\s*/, "").slice(0, 160);
}

function statusIcon(status?: string) {
  switch (status) {
    case "completed": return <CircleCheck size={13} className="text-(--color-green)" />;
    case "failed": return <CircleX size={13} className="text-(--color-red)" />;
    case "in_progress": return <CircleDashed size={13} className="text-(--color-status-running) animate-spin" />;
    default: return <CircleDashed size={13} className="text-(--color-dim)" />;
  }
}

export const ToolCard = memo(function ToolCard({ tool }: { tool: ToolCallUpdate }) {
  const [open, setOpen] = useState(false);
  const icon = KIND_ICON[tool.kind ?? "other"] ?? KIND_ICON.other;
  const meta = (tool._meta ?? {}) as Record<string, unknown>;
  const cwdRaw = meta["cognition.ai/cwd"];
  const cwd = typeof cwdRaw === "string" ? cwdRaw : undefined;
  // cognition.ai/terminalPreview is a boolean flag on the current wire —
  // the preview text lives in the tool's content blocks. Older builds sent
  // the text itself, so accept either shape.
  const previewFlag = meta["cognition.ai/terminalPreview"];
  const termPreview = (() => {
    if (typeof previewFlag === "string") return previewFlag;
    if (previewFlag !== true) return undefined;
    const text = (tool.content ?? [])
      .flatMap((c) =>
        c.type === "content" && c.content.type === "text" ? [c.content.text] : [],
      )
      .join("\n")
      .trim();
    return text || undefined;
  })();
  const toolNameRaw = meta["cognition.ai/inferenceToolName"];
  const toolName = typeof toolNameRaw === "string" ? toolNameRaw : undefined;
  const title = tool.title || toolName || tool.toolCallId;
  // write_plan ships diff blocks whose newText IS the plan markdown — the
  // Rendered toggle swaps the diff view for the rendered document
  const [rendered, setRendered] = useState(false);
  const writePlanDiffs =
    toolName === "write_plan"
      ? (tool.content ?? []).filter((c): c is Extract<typeof c, { type: "diff" }> => c.type === "diff")
      : [];
  // exit_plan_mode carries the plan markdown in rawInput.plan
  const exitPlanRaw = tool.rawInput;
  const exitPlanText =
    toolName === "exit_plan_mode" &&
    !!exitPlanRaw &&
    typeof exitPlanRaw === "object" &&
    !Array.isArray(exitPlanRaw) &&
    typeof (exitPlanRaw as Record<string, unknown>).plan === "string"
      ? (exitPlanRaw as { plan: string }).plan
      : undefined;

  return (
    <div className="border border-(--color-border) rounded-lg bg-(--color-panel) overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-(--color-panel2)"
      >
        <span className="text-(--color-dim)">{icon}</span>
        <span className="flex-1 truncate">{title}</span>
        {cwd && <span className="text-tiny text-(--color-dim) mono hidden sm:inline">{cwd}</span>}
        {statusIcon(tool.status)}
        {open ? <ChevronDown size={13} className="text-(--color-dim)" /> : <ChevronRight size={13} className="text-(--color-dim)" />}
      </button>
      {termPreview && !open && (
        // justify-end pins the text to the bottom so the clip shows the
        // latest lines, not the first 1200-char chunk's head
        <div className="bg-(--color-code-bg) border-t border-(--color-border) max-h-24 flex flex-col justify-end overflow-hidden">
          <pre className="mono text-2xs px-3 py-1.5 overflow-x-auto whitespace-pre-wrap text-(--color-dim)">
            {termPreview.slice(-1200)}
          </pre>
        </div>
      )}
      {open && (
        <div className="border-t border-(--color-border) px-3 py-2 flex flex-col gap-2">
          {termPreview && (
            <pre className="mono text-xs bg-(--color-code-bg) rounded p-2 overflow-x-auto whitespace-pre-wrap">{termPreview}</pre>
          )}
          {tool.locations?.map((l) => (
            <div key={l.path} className="mono text-xs text-(--color-accent) truncate">{l.path}</div>
          ))}
          {writePlanDiffs.length > 0 && (
            <div>
              <button
                type="button"
                aria-pressed={rendered}
                onClick={() => setRendered((v) => !v)}
                className={`text-2xs px-2 py-0.5 rounded border ${
                  rendered
                    ? "border-(--color-accent)/50 text-(--color-accent) bg-(--color-accent)/10"
                    : "border-(--color-border) text-(--color-dim) hover:text-white"
                }`}
              >
                Rendered
              </button>
            </div>
          )}
          {writePlanDiffs.length > 0 && rendered ? (
            <div className="flex flex-col gap-2">
              {writePlanDiffs.map((c, i) => (
                <div key={i} className="rounded bg-(--color-panel2) p-2 text-sm overflow-x-auto">
                  <Markdown>{c.newText}</Markdown>
                </div>
              ))}
            </div>
          ) : (
            tool.content?.map((c, i) => <ToolContent key={i} c={c} />)
          )}
          {exitPlanText && (
            <div className="max-h-72 overflow-y-auto rounded bg-(--color-panel2) p-3 text-sm">
              <Markdown>{exitPlanText}</Markdown>
            </div>
          )}
          {tool.rawInput != null && (
            <details className="text-xs">
              <summary className="text-(--color-dim) cursor-pointer">input</summary>
              <pre className="mono text-xs bg-(--color-code-bg) rounded p-2 mt-1 overflow-x-auto">
                {JSON.stringify(tool.rawInput, null, 2).slice(0, 4000)}
              </pre>
            </details>
          )}
          {tool.rawOutput != null && (
            <details className="text-xs">
              <summary className="text-(--color-dim) cursor-pointer">output</summary>
              <pre className="mono text-xs bg-(--color-code-bg) rounded p-2 mt-1 overflow-x-auto">
                {typeof tool.rawOutput === "string" ? tool.rawOutput.slice(0, 8000) : JSON.stringify(tool.rawOutput, null, 2).slice(0, 8000)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
});

/** The live in-place plan card — the newest plan card opens, older ones
 *  (their snapshots live on in the dock/panel timeline) stay collapsed. */
function PlanItem({ item }: { item: Extract<ChatItem, { kind: "plan" }> }) {
  const ctx = useContext(PlanMetaCtx);
  const isLatest = ctx ? ctx.latestPlanItemId === item.id : true;
  const [open, setOpen] = useState(() => isLatest);
  const { done, total } = planProgress(item.entries);
  return (
    <div className="border border-(--color-border) rounded-lg bg-(--color-panel)">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-(--color-panel2)"
      >
        <ListChecks size={14} className="text-(--color-accent)" />
        <span className="font-medium">Plan</span>
        <span className="flex-1" />
        <span className="mono text-2xs text-(--color-dim)">
          {done}/{total}
        </span>
        {open ? <ChevronDown size={13} className="text-(--color-dim)" /> : <ChevronRight size={13} className="text-(--color-dim)" />}
      </button>
      {open && (
        <div className="px-3 pb-3">
          <PlanChecklist entries={item.entries} />
        </div>
      )}
    </div>
  );
}

/** A durable todo_write tool row — the saved record of a plan revision.
 *  Renders as a plan checklist card with the diff chips from the snapshot
 *  timeline (previous snapshot's entries → this row's). */
function PlanUpdateCard({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const ctx = useContext(PlanMetaCtx);
  const [open, setOpen] = useState(false);
  const entries = todoEntries(item.tool) ?? [];
  const { done, total } = planProgress(entries);
  const diff = diffPlan(ctx?.diffs.get(item.id) ?? null, entries);
  return (
    <div className="border border-(--color-border) rounded-lg bg-(--color-panel) overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-(--color-panel2)"
      >
        <ListChecks size={14} className="text-(--color-accent) shrink-0" />
        <span className="flex-1 truncate min-w-0">
          Plan update · {done}/{total}
        </span>
        <DiffChips diff={diff} />
        {statusIcon(item.tool.status)}
        {open ? <ChevronDown size={13} className="text-(--color-dim)" /> : <ChevronRight size={13} className="text-(--color-dim)" />}
      </button>
      {open && (
        <div className="border-t border-(--color-border) px-3 py-2 flex flex-col gap-2">
          <PlanChecklist entries={entries} />
          {item.tool.rawInput != null && (
            <details className="text-xs">
              <summary className="text-(--color-dim) cursor-pointer">input</summary>
              <pre className="mono text-xs bg-(--color-code-bg) rounded p-2 mt-1 overflow-x-auto">
                {JSON.stringify(item.tool.rawInput, null, 2).slice(0, 4000)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
