"use client";

import { useState } from "react";
import {
  Brain, Check, Copy, Download, Eye, FileDiff, FolderTree, Gauge, GitBranch, History,
  ListChecks, Menu, MessageSquare, MoreHorizontal, Pencil, Search, Share2, Terminal, X,
} from "lucide-react";
import { displayTitle, tildePath } from "@/lib/client/display";
import { forkSession, renameSession, sendPrompt, shareSession } from "@/lib/client/api";
import { isImeComposing } from "@/lib/client/keys";
import { useToast } from "./Toasts";
import { useConfirm } from "./ConfirmDialog";
import { Dropdown } from "./ContextMenu";
import type { useSessionView } from "@/hooks/useSessionView";

type ViewState = ReturnType<typeof useSessionView>["state"];

export type ChatPanel = "chat" | "files" | "changes" | "terminal" | "history" | "plan";

function TabBtn({ icon, label, active, onClick, className }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      // icon-only below sm — keep an accessible name (and a hover title)
      aria-label={label}
      title={label}
      role="tab"
      aria-selected={active}
      className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-2 sm:py-1.5 rounded-md text-xs transition-colors ${
        active ? "bg-(--color-panel3) text-white" : "text-(--color-dim) hover:text-white"
      } ${className ?? ""}`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

/** Session header — title/rename, model+bypass badges, panel tabs,
 *  watchers/usage and the ⋯ session-action menu. Owns the rename draft and
 *  the usage popover so the parent only passes view state. */
export default function ChatHeader({
  sessionId,
  cwd,
  title,
  connected,
  bypass,
  modelBadge,
  thoughtBadge,
  usage,
  commands,
  watchers,
  hasPlan,
  panel,
  onPanel,
  onOpenSidebar,
  expandAll,
  onToggleExpandAll,
  onFind,
}: {
  sessionId: string;
  cwd: string;
  title?: string;
  connected: boolean;
  /** bypass-permissions mode — badge + caution styling */
  bypass: boolean;
  modelBadge: string;
  thoughtBadge: string;
  usage: ViewState["usage"];
  commands: ViewState["commands"];
  watchers: number;
  hasPlan: boolean;
  panel: ChatPanel;
  onPanel: (p: ChatPanel) => void;
  onOpenSidebar?: () => void;
  expandAll: boolean;
  onToggleExpandAll: () => void;
  /** find-in-session / prompt outline sheet */
  onFind?: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState("");
  const [usageOpen, setUsageOpen] = useState(false);
  const fail = (what: string) => (e: unknown) => toast(`${what} failed: ${(e as Error).message}`);

  const usagePct = usage?.size ? Math.round((usage.used / usage.size) * 100) : 0;
  // /compact is a slash command, not a button API — only offer it when the
  // agent actually advertises it (command entries are untyped-ish JSON)
  const canCompact = (commands ?? []).some(
    (c) => c != null && typeof c === "object" && (c as { name?: unknown }).name === "compact",
  );

  const doRename = async () => {
    const t = renameText.trim();
    setRenaming(false);
    setRenameText("");
    if (!t) return;
    try {
      const res = await renameSession(sessionId, t);
      if (res.queued) toast("Rename queued — applies after the current turn.", "info");
    } catch (e) {
      fail("Rename")(e);
    }
  };

  const doShare = async () => {
    if (
      (await confirm({
        title: "Share this session?",
        body: "Anyone with the link can view it.",
        confirmLabel: "Share",
      })) !== "confirm"
    )
      return;
    try {
      await shareSession(sessionId);
      toast("Share requested — the link will appear in the conversation.", "info");
    } catch (e) {
      fail("Share")(e);
    }
  };

  const forkHead = () => {
    if (!cwd) {
      toast("Fork failed: session directory is unknown — reopen the session and retry.");
      return;
    }
    void forkSession(sessionId, cwd)
      .then((r) => {
        // native history (not router.replace) keeps the Suspense tree and
        // its toasts mounted; push so Back returns to the original session
        if (r?.sessionId) window.history.pushState(null, "", `?s=${encodeURIComponent(r.sessionId)}`);
      })
      .catch(fail("Fork"));
  };

  const menuItems = [
    ...(usage
      ? [{
          // mobile hides the inline usage pill; the ⋯ menu keeps it reachable
          label: `Token usage — ${Math.round(usage.used / 1000)}k/${Math.round(usage.size / 1000)}k`,
          icon: <Gauge size={13} />,
          onClick: () => setUsageOpen(true),
        }]
      : []),
    {
      label: "Rename session",
      icon: <Pencil size={13} />,
      onClick: () => {
        setRenameText(title ?? "");
        setRenaming(true);
      },
    },
    {
      label: "Fork session",
      icon: <GitBranch size={13} />,
      onClick: forkHead,
    },
    {
      label: "Share session",
      icon: <Share2 size={13} />,
      onClick: () => void doShare(),
    },
    {
      label: expandAll ? "Collapse all thoughts" : "Expand all thoughts",
      icon: <Brain size={13} />,
      onClick: onToggleExpandAll,
    },
    {
      label: "Copy session ID",
      icon: <Copy size={13} />,
      onClick: () => void navigator.clipboard.writeText(sessionId).catch(() => {}),
    },
    {
      label: "Export markdown",
      icon: <Download size={13} />,
      onClick: () => window.open(`/api/sessions/${sessionId}/export`, "_blank"),
    },
    {
      label: "Export JSON",
      icon: <Download size={13} />,
      onClick: () => window.open(`/api/sessions/${sessionId}/export?format=json`, "_blank"),
    },
  ];

  return (
    <div className="relative flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-2 border-b border-(--color-border) bg-(--color-panel) pt-[calc(0.5rem+env(safe-area-inset-top))]">
      {/* phones hide the context chip — a hairline along the header's
          bottom edge carries the same fill level (amber/red near the cap) */}
      {usage?.size ? (
        <span
          className="sm:hidden absolute left-0 bottom-0 h-0.5 pointer-events-none"
          style={{ width: `${Math.min(100, usagePct)}%` }}
          aria-hidden
        >
          <span
            className={`block h-full ${usagePct >= 90 ? "bg-(--color-danger)" : usagePct >= 80 ? "bg-(--color-warning)" : "bg-(--color-accent)/50"}`}
          />
        </span>
      ) : null}
      {onOpenSidebar && (
        <button onClick={onOpenSidebar} className="md:hidden p-2 -ml-1 rounded-lg text-(--color-dim) hover:text-white hover:bg-(--color-panel2)" title="Sessions" aria-label="Open sessions">
          <Menu size={17} />
        </button>
      )}
      <div className="flex-1 min-w-0">
        {renaming ? (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return;
                if (e.key === "Enter") void doRename();
                if (e.key === "Escape") setRenaming(false);
              }}
              placeholder={title || sessionId}
              className="bg-(--color-panel2) border border-(--color-border) rounded-lg px-2.5 py-1 text-sm outline-none focus:border-(--color-accent) w-full max-w-xs"
            />
            <button onClick={() => void doRename()} className="p-1.5 rounded text-(--color-success) hover:bg-(--color-panel2)"><Check size={14} /></button>
            <button onClick={() => setRenaming(false)} className="p-1.5 rounded text-(--color-dim) hover:bg-(--color-panel2)"><X size={14} /></button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-sm font-medium" title={title || sessionId}>{displayTitle(title, sessionId)}</span>
            {bypass && (
              <span
                className="text-(--color-danger) border border-(--color-danger)/40 rounded px-1 text-tiny shrink-0"
                title="Bypass Permissions — tool calls auto-approve"
              >
                Bypass
              </span>
            )}
            {modelBadge && (
              <span
                className="hidden sm:inline mono text-tiny text-(--color-faint) truncate max-w-44 shrink-0"
                title={`${modelBadge}${thoughtBadge ? ` · ${thoughtBadge}` : ""}`}
              >
                {modelBadge}
                {thoughtBadge ? ` · ${thoughtBadge}` : ""}
              </span>
            )}
            {!connected && (
              <span className="text-(--color-warning) text-2xs shrink-0 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-(--color-warning) animate-pulse" />
                connecting…
              </span>
            )}
          </div>
        )}
        <div className="hidden sm:block truncate text-2xs text-(--color-faint) mono" title={cwd}>{tildePath(cwd)}</div>
      </div>
      <div role="tablist" aria-label="Session views" className="flex items-center rounded-lg bg-(--color-panel2) border border-(--color-border) p-0.5">
        {/* Chat is the mobile navigation back-stop — on md+ the chat is
            always visible beside the docked panel, so its tab is hidden
            and clicking an active panel tab just closes the panel */}
        <TabBtn className="md:hidden" icon={<MessageSquare size={14} />} label="Chat" active={panel === "chat"} onClick={() => onPanel("chat")} />
        <TabBtn icon={<FolderTree size={14} />} label="Files" active={panel === "files"} onClick={() => onPanel(panel === "files" ? "chat" : "files")} />
        <TabBtn icon={<FileDiff size={14} />} label="Changes" active={panel === "changes"} onClick={() => onPanel(panel === "changes" ? "chat" : "changes")} />
        <TabBtn icon={<Terminal size={14} />} label="Terminals" active={panel === "terminal"} onClick={() => onPanel(panel === "terminal" ? "chat" : "terminal")} />
        <TabBtn icon={<History size={14} />} label="History" active={panel === "history"} onClick={() => onPanel(panel === "history" ? "chat" : "history")} />
        {hasPlan && (
          <TabBtn icon={<ListChecks size={14} />} label="Plan" active={panel === "plan"} onClick={() => onPanel(panel === "plan" ? "chat" : "plan")} />
        )}
      </div>
      {watchers > 1 && (
        <span
          className="flex items-center gap-0.5 text-tiny text-(--color-faint) mono px-1"
          title={`${watchers} clients viewing this session`}
        >
          <Eye size={11} />{watchers}
        </span>
      )}
      {usage && (
        <span className="relative">
          <button
            onClick={() => setUsageOpen((v) => !v)}
            className={`hidden sm:inline-block text-tiny mono px-1 py-0.5 rounded ${
              usagePct >= 90
                ? "text-(--color-danger)"
                : usagePct >= 80
                  ? "text-(--color-warning)"
                  : "text-(--color-faint) hover:text-(--color-dim)"
            }`}
            title={`Context window: ${usagePct}% used`}
            aria-label={`Context ${usagePct}% used`}
            aria-expanded={usageOpen}
          >
            <span className="text-(--color-faint)">ctx </span>
            {Math.round(usage.used / 1000)}k/{Math.round(usage.size / 1000)}k
            <span className="block h-0.5 mt-0.5 rounded-full bg-(--color-panel3) overflow-hidden" aria-hidden>
              <span
                className={`block h-full ${usagePct >= 90 ? "bg-(--color-danger)" : usagePct >= 80 ? "bg-(--color-warning)" : "bg-(--color-accent)/70"}`}
                style={{ width: `${Math.min(100, usagePct)}%` }}
              />
            </span>
          </button>
          {usageOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setUsageOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-50 w-48 rounded-lg border border-(--color-border) bg-(--color-panel) p-3 shadow-lg">
                <div className="flex justify-between text-tiny text-(--color-dim) mb-1">
                  <span>Context</span>
                  <span className={usagePct >= 90 ? "text-(--color-danger)" : usagePct >= 80 ? "text-(--color-warning)" : ""}>
                    {usagePct}%
                  </span>
                </div>
                <div className="h-1 rounded-full bg-(--color-panel2) overflow-hidden mb-2.5">
                  <div
                    className="h-full bg-(--color-accent)"
                    style={{ width: `${usage.size ? Math.min(100, (usage.used / usage.size) * 100) : 0}%` }}
                  />
                </div>
                <div className="mono text-tiny text-(--color-dim) space-y-1">
                  <div className="flex justify-between"><span>context</span><span>{usage.used.toLocaleString()} / {usage.size.toLocaleString()}</span></div>
                  {usage.inputTokens != null && (
                    <div className="flex justify-between"><span>input</span><span>{usage.inputTokens.toLocaleString()}</span></div>
                  )}
                  {usage.outputTokens != null && (
                    <div className="flex justify-between"><span>output</span><span>{usage.outputTokens.toLocaleString()}</span></div>
                  )}
                </div>
                {canCompact && (
                  <button
                    onClick={() => {
                      setUsageOpen(false);
                      void sendPrompt(sessionId, "/compact").catch(fail("/compact"));
                    }}
                    className="mt-2.5 w-full text-2xs px-2 py-1 rounded-md border border-(--color-border) text-(--color-dim) hover:text-white hover:bg-(--color-panel2)"
                  >
                    Run /compact
                  </button>
                )}
              </div>
            </>
          )}
        </span>
      )}
      {onFind && (
        <button
          onClick={onFind}
          className="p-2 sm:p-1.5 rounded-lg text-(--color-dim) hover:text-white hover:bg-(--color-panel2)"
          title="Find in session"
          aria-label="Find in session"
        >
          <Search size={16} />
        </button>
      )}
      <Dropdown
        trigger={<MoreHorizontal size={16} />}
        title="Session actions"
        items={menuItems}
        className="p-1.5 rounded-lg text-(--color-dim) hover:text-white hover:bg-(--color-panel2)"
      />
    </div>
  );
}
