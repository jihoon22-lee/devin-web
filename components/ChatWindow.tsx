"use client";

import { useSessionView } from "@/hooks/useSessionView";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  dequeuePrompt, forkSession, sendQueuedPrompt,
} from "@/lib/client/api";
import { useToast } from "./Toasts";
import { useConfirm } from "./ConfirmDialog";
import MessageItem, { ItemBoundary } from "./MessageItem";
import ChatHeader, { type ChatPanel } from "./ChatHeader";
import StatusBar from "./StatusBar";
import ChatInput from "./ChatInput";
import TerminalPanel from "./TerminalPanel";
import FileExplorer from "./FileExplorer";
import ChangesPanel from "./ChangesPanel";
import HistoryPanel from "./HistoryPanel";
import BranchView from "./BranchView";
import ResizablePanel from "./ResizablePanel";
import { useTurnDoneToast, useTurnTitleNotify, useRequestNotify } from "@/hooks/useTurnNotify";
import { ArrowDown, GitBranch, Pencil, SendHorizontal, X } from "lucide-react";
import { renderItems, type ChatItem } from "@/lib/client/model";
import { planSnapshots } from "@/lib/client/plan";
import type { PlanEntry } from "@/lib/acp/types";
import { classifyConfig, shortModelName } from "@/lib/client/configOptions";
import { PlanMetaCtx, ThoughtExpandCtx } from "./PlanMetaCtx";
import PlanDock from "./PlanDock";
import PlanPanel from "./PlanPanel";
import ToolRunGroup from "./ToolRunGroup";
import { groupToolRuns, indexToolRuns, toolRunSummary } from "@/lib/client/toolRuns";
import { findJumpTarget, needsOlderPageForJump, type JumpTarget } from "@/lib/client/jump";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { fmtDuration, turnSummaries } from "@/lib/client/turnSummary";
import FindSheet from "./FindSheet";

export default function ChatWindow({
  sessionId,
  cwd,
  jump,
  detached,
  onReattach,
  onOpenSidebar,
}: {
  sessionId: string;
  cwd: string;
  jump?: JumpTarget | null;
  /** the agent restarted and could not reload this session */
  detached?: boolean;
  onReattach?: () => void;
  onOpenSidebar?: () => void;
}) {
  const { state, connected, loadOlder } = useSessionView(sessionId);
  // Render durable rows, retained items, the running turn and overlay
  // notices. Memoized on the state object — a ticking timer or focus change
  // used to redo the whole assembly every render.
  const items = useMemo(() => renderItems(state), [state]);
  const { scrollRef, onScroll, atBottom, jumpToBottom, unpin } = useStickToBottom(items, sessionId);
  // prepending an older page shifts every row down — keep the viewport
  // anchored by restoring the distance-from-bottom after the render lands
  const shift = useRef<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadOlderClick = () => {
    const el = scrollRef.current;
    if (el) shift.current = el.scrollHeight - el.scrollTop;
    setLoadingOlder(true);
    void loadOlder().finally(() => setLoadingOlder(false));
  };
  useEffect(() => {
    if (shift.current == null || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight - shift.current;
    shift.current = null;
  }, [items, scrollRef]);
  const [panel, setPanel] = useState<ChatPanel>("chat");
  const [findOpen, setFindOpen] = useState(false);
  // segment/branch overlay opened from the history panel — a read-only
  // transcript of a non-live span; fork-at-node works inside it
  const [branchView, setBranchView] = useState<{ query: string; label: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const jumpDone = useRef(0);
  /** jumps raised inside the chat (Find outline) — negative nonces so they
   *  never collide with AppShell's search-hit jumps */
  const [ownJump, setOwnJump] = useState<JumpTarget | null>(null);
  const ownJumpSeq = useRef(0);
  // "Expand all thoughts" — a viewer preference, persisted per browser
  const [expandAll, setExpandAll] = useState(() => {
    try {
      return localStorage.getItem("dw-expand-thoughts") === "1";
    } catch {
      return false; // SSR / storage denied
    }
  });
  const toggleExpandAll = () =>
    setExpandAll((v) => {
      const n = !v;
      try {
        localStorage.setItem("dw-expand-thoughts", n ? "1" : "0");
      } catch {
        /* private mode — session-only then */
      }
      return n;
    });

  // consecutive tool calls collapse into ToolRunGroups — the map tells a
  // jump which group holds the target so it can expand first
  const rows = useMemo(() => groupToolRuns(items), [items]);
  // finished-turn footers ("2m 14s · 12 tools · 3 edits"), keyed by the
  // turn's last item — rendered after the row that holds it
  const summaries = useMemo(
    () => turnSummaries(items, !state.running && !(state.provisional ?? []).length),
    [items, state.running, state.provisional],
  );
  const itemToRun = useMemo(() => indexToolRuns(rows), [rows]);
  const [runPrefs, setRunPrefs] = useState<Map<string, boolean>>(new Map());
  const runOpen = (row: Extract<(typeof rows)[number], { type: "group" }>) =>
    // a run containing a live tool stays open — collapsing it would hide
    // the activity the user is watching; done runs collapse by default
    runPrefs.get(row.id) ?? !toolRunSummary(row.items).active;

  /** Scroll+flash a rendered item — shared by search jumps and the plan
   *  dock/panel history rows. */
  const jumpToItem = (id: string) => {
    unpin();
    const g = itemToRun.get(id);
    if (g) flushSync(() => setRunPrefs((p) => new Map(p).set(g, true)));
    requestAnimationFrame(() => {
      // Pagination can queue a bottom-scroll event between the effect and
      // this frame, re-enabling stickiness. Unpin at the actual jump too so
      // the following resize/render cannot pull the target back to the tail.
      unpin();
      document.getElementById(`msg-${id}`)?.scrollIntoView({ block: "center" });
      setFlash(id);
      setTimeout(() => setFlash(null), 1800);
    });
  };

  // plan snapshot timeline — feeds the dock, the Plan tab, each card's diff
  // chips (previous snapshot's entries) and the latest-card open default
  const planSnaps = useMemo(() => planSnapshots(items), [items]);
  const planDiffs = useMemo(() => {
    const m = new Map<string, PlanEntry[] | null>();
    const lastIdx = new Map<string, number>();
    planSnaps.forEach((s, i) => lastIdx.set(s.itemId, i));
    planSnaps.forEach((s, i) => {
      if (lastIdx.get(s.itemId) === i) m.set(s.itemId, planSnaps[i - 1]?.entries ?? null);
    });
    return m;
  }, [planSnaps]);
  const latestPlanItemId = planSnaps[planSnaps.length - 1]?.itemId;
  const planMeta = useMemo(
    () => ({ diffs: planDiffs, latestPlanItemId }),
    [planDiffs, latestPlanItemId],
  );
  // the live mode surfaces two ways — the dedicated modeId meta and the
  // mode config option's currentValue; either reporting bypass arms the
  // header badge and the red status-bar dot
  const cfg = useMemo(() => classifyConfig(state.configOptions), [state.configOptions]);
  const bypass =
    state.modeId === "bypass" || String(cfg.mode?.currentValue ?? "") === "bypass";
  // header model badge — option display name + thought level, hidden when
  // the agent doesn't expose a model option
  const modelBadge = cfg.model
    ? shortModelName(cfg.model, String(cfg.model.currentValue ?? ""))
    : "";
  const thoughtBadge = cfg.thought
    ? shortModelName(cfg.thought, String(cfg.thought.currentValue ?? ""))
    : "";
  // search-hit jump: node id for durable rows, anchor only for provisional;
  // a hit above the loaded window pages older rows in (bounded)
  const jumpPages = useRef<{ n: number; pages: number }>({ n: -1, pages: 0 });
  // a newer search-hit jump from AppShell supersedes an outline jump —
  // adjusted during render, like other prop-derived state here
  const [prevJump, setPrevJump] = useState(jump);
  if (prevJump !== jump) {
    setPrevJump(jump);
    setOwnJump(null);
  }
  const activeJump = ownJump ?? jump;
  useEffect(() => {
    const jump = activeJump;
    if (!jump || jumpDone.current === jump.n) return;
    const target = findJumpTarget(items, jump);
    if (!target) {
      if (jumpPages.current.n !== jump.n) jumpPages.current = { n: jump.n, pages: 0 };
      if (
        !loadingOlder &&
        jumpPages.current.pages < 20 &&
        needsOlderPageForJump(items, jump, !!state.historyTruncated)
      ) {
        jumpPages.current.pages++;
        loadOlderClick();
      }
      return;
    }
    jumpDone.current = jump.n;
    jumpToItem(target.id);
  }, [activeJump, items, unpin, loadingOlder, state.historyTruncated]); // eslint-disable-line react-hooks/exhaustive-deps -- loadOlderClick/jumpToItem are recreated every render; guarded by loadingOlder

  const toast = useToast();
  const confirm = useConfirm();
  const fail = (what: string) => (e: unknown) => toast(`${what} failed: ${(e as Error).message}`);

  // queued-prompt actions shared by the ghost bubbles and the status-bar
  // popover — edit restores the blocks into the composer via dw-restore
  const sendQueued = (id: string) =>
    void sendQueuedPrompt(sessionId, id).catch(fail("Send queued prompt"));
  const editQueued = (id: string) =>
    void dequeuePrompt(sessionId, id)
      .then((r) =>
        window.dispatchEvent(
          new CustomEvent("dw-restore", { detail: { sessionId, blocks: r.blocks } }),
        ),
      )
      .catch(fail("Edit queued prompt"));
  const dropQueued = (id: string) =>
    void dequeuePrompt(sessionId, id).catch(fail("Remove queued prompt"));

  // turn/request notifications — title ping when hidden, toast when
  // visible, system notify for pending requests (hooks/useTurnNotify.ts)
  useTurnTitleNotify(sessionId, state.running, state.title ?? "");
  useTurnDoneToast(sessionId, state.running, state.runningSince, items, toast);
  useRequestNotify(sessionId, state.title ?? "", items);

  /** Fork the session at an arbitrary message node — the route resolves the
   *  covering revert step and clones up to its fork anchor (needs the
   *  agent's cognition.ai/revert capability; the error toasts otherwise). */
  const forkAt = async (nodeId: number) => {
    if (!cwd) {
      toast("Fork failed: session directory is unknown — reopen the session and retry.");
      return;
    }
    if (
      (await confirm({
        title: `Fork this session at message node ${nodeId}?`,
        body: "A new session is created from that point.",
        confirmLabel: "Fork",
      })) !== "confirm"
    )
      return;
    void forkSession(sessionId, cwd, nodeId)
      .then((r) => {
        // native history keeps the Suspense tree + toasts mounted; push so
        // Back returns to the original session (same as the head fork)
        if (r?.sessionId) window.history.pushState(null, "", `?s=${encodeURIComponent(r.sessionId)}`);
      })
      .catch(fail("Fork"));
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ChatHeader
        sessionId={sessionId}
        cwd={cwd}
        title={state.title}
        connected={connected}
        bypass={bypass}
        modelBadge={modelBadge}
        thoughtBadge={thoughtBadge}
        usage={state.usage}
        commands={state.commands}
        watchers={state.watchers ?? 0}
        hasPlan={planSnaps.length > 0}
        panel={panel}
        onPanel={setPanel}
        onOpenSidebar={onOpenSidebar}
        expandAll={expandAll}
        onToggleExpandAll={toggleExpandAll}
        onFind={() => setFindOpen(true)}
      />
      {findOpen && (
        <FindSheet
          sessionId={sessionId}
          items={items}
          canLoadOlder={!!state.historyTruncated && !!items[0]?.id.startsWith("bf-")}
          loadingOlder={loadingOlder}
          onLoadOlder={loadOlderClick}
          onJump={(id) => {
            setPanel("chat"); // a phone may be on another tab
            jumpToItem(id);
          }}
          onJumpNode={(nodeId) => {
            setPanel("chat");
            setOwnJump({ nodeId, n: -++ownJumpSeq.current });
          }}
          onClose={() => setFindOpen(false)}
        />
      )}

      {detached && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-(--color-red)/40 bg-(--color-red)/10 text-(--color-red)">
          <span className="flex-1">
            This session is detached — the agent restarted and could not reload it.
          </span>
          {onReattach && (
            <button onClick={onReattach} className="underline underline-offset-2 shrink-0">
              Reattach
            </button>
          )}
        </div>
      )}

      {/* body — on md+ the side panel docks to the RIGHT of the chat
          column; on mobile it still replaces the chat entirely */}
      <div className="flex-1 min-h-0 flex">
        <div className={`relative flex-1 min-w-0 flex flex-col ${panel === "chat" ? "" : "hidden md:flex"}`}>
          <PlanMetaCtx.Provider value={planMeta}>
          <ThoughtExpandCtx.Provider value={expandAll}>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="flex-1 overflow-y-auto px-3 py-4"
          >
            <div className="max-w-3xl mx-auto flex flex-col gap-2.5">
              {state.historyTruncated &&
                !items.some((i) => i.kind === "text" && i.role === "user") && (
                  <div className="self-center text-center text-xs text-(--color-faint) px-3 py-1">
                    Context was compressed — earlier messages live on a previous branch.
                  </div>
                )}
              {state.historyTruncated && items[0]?.id.startsWith("bf-") && (
                <button
                  onClick={loadOlderClick}
                  disabled={loadingOlder}
                  className="self-center text-xs text-(--color-dim) hover:text-white px-3 py-1 rounded-full border border-(--color-border) hover:bg-(--color-panel2) disabled:opacity-50"
                >
                  {loadingOlder ? "Loading…" : "Load earlier messages"}
                </button>
              )}
              {items.length === 0 && (
                <div className="text-center text-(--color-faint) text-sm mt-16" aria-live="polite">
                  {/* no view snapshot yet — a cold attach can take seconds
                      on a phone; don't present a loading session as empty */}
                  {state.v == null
                    ? "Loading conversation…"
                    : state.running
                      ? "Devin is starting…"
                      : "Send a message to begin."}
                </div>
              )}
              {rows.map((row) => {
                // bf- items carry the durable node id — fork-at-node can
                // target them; live-only items have no stable point yet
                const renderItem = (item: ChatItem) => {
                  const nodeId = item.id.startsWith("bf-") ? Number(item.id.slice(3)) : NaN;
                  return (
                    <div
                      key={item.id}
                      id={`msg-${item.id}`}
                      className={`group relative dw-virt flex flex-col rounded-lg transition-shadow duration-500 ${flash === item.id ? "ring-2 ring-(--color-accent)" : ""}` /* flex-col lets self-end align user bubbles */}
                    >
                      <ItemBoundary>
                        <MessageItem item={item} sessionId={sessionId} />
                      </ItemBoundary>
                      {Number.isFinite(nodeId) && (
                        <button
                          onClick={() => forkAt(nodeId)}
                          className="absolute top-0 right-0 z-10 p-1 rounded-md border border-(--color-border) bg-(--color-panel) text-(--color-dim) opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-white [@media(hover:none)]:opacity-60"
                          title={`Fork the session from this message (node ${nodeId})`}
                          aria-label="Fork from this message"
                        >
                          <GitBranch size={11} />
                        </button>
                      )}
                    </div>
                  );
                };
                const lastId = row.type === "item" ? row.item.id : row.items[row.items.length - 1]?.id;
                const sum = lastId ? summaries.get(lastId) : undefined;
                const footer = sum && (
                  <div
                    className="self-start flex items-center gap-1.5 pl-1 -mt-1 text-tiny mono text-(--color-faint)"
                    aria-label="Turn summary"
                  >
                    {[
                      sum.ms != null ? fmtDuration(sum.ms) : null,
                      sum.tools ? `${sum.tools} tool${sum.tools > 1 ? "s" : ""}` : null,
                      sum.edits ? `${sum.edits} edit${sum.edits > 1 ? "s" : ""}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                );
                // one keyed fragment per row — an unkeyed [item, footer] array
                // is keyed by index, so prepending an older page remounted
                // every row (and lost the jump scroll position)
                if (row.type === "item")
                  return (
                    <Fragment key={row.item.id}>
                      {renderItem(row.item)}
                      {footer}
                    </Fragment>
                  );
                const open = runOpen(row);
                return (
                  <Fragment key={row.id}>
                  <ToolRunGroup
                    items={row.items}
                    open={open}
                    onToggle={() =>
                      setRunPrefs((p) => new Map(p).set(row.id, !open))
                    }
                  >
                    {row.items.map(renderItem)}
                  </ToolRunGroup>
                  {footer}
                  </Fragment>
                );
              })}
              {/* queued prompts as ghost bubbles — visible at send time,
                  derived from queueItems so edit/drop retracts them; the
                  real bubble lands when the queue drains (echoId dedup) */}
              {(state.queueItems ?? []).map((q) => (
                <div
                  key={q.id}
                  className="group self-end max-w-[85%] bg-(--color-accent)/8 border border-dashed border-(--color-accent)/40 rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
                >
                  <div className="text-tiny uppercase tracking-wide text-(--color-faint) mb-0.5 flex items-center justify-between gap-2">
                    <span>queued — sends when the current turn ends</span>
                    {/* inline actions — hover/focus on pointers, always
                        visible on touch (no hover to discover them) */}
                    <span className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100">
                      {state.running && (
                        <button
                          className="p-1 [@media(pointer:coarse)]:p-2 rounded text-(--color-accent) hover:bg-(--color-accent)/15"
                          title="Send now — steers the running turn at its next step"
                          aria-label="Send queued prompt now"
                          onClick={() => sendQueued(q.id)}
                        >
                          <SendHorizontal size={11} />
                        </button>
                      )}
                      <button
                        className="p-1 [@media(pointer:coarse)]:p-2 rounded text-(--color-dim) hover:bg-(--color-panel3) hover:text-(--color-text)"
                        title="Move back into the input to edit"
                        aria-label="Edit queued prompt"
                        onClick={() => editQueued(q.id)}
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        className="p-1 [@media(pointer:coarse)]:p-2 rounded text-(--color-dim) hover:bg-(--color-red)/15 hover:text-(--color-red)"
                        title="Drop this queued prompt"
                        aria-label="Drop queued prompt"
                        onClick={() => dropQueued(q.id)}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  </div>
                  {q.mentions && q.mentions.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1">
                      {q.mentions.map((m) => (
                        <span key={m.path} className="mono text-tiny bg-(--color-accent)/25 rounded px-1.5 py-0.5" title={m.path}>
                          @{m.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {q.text}
                  {q.attachments ? (
                    <div className="text-tiny text-(--color-faint) mt-0.5">
                      {q.attachments} attachment{q.attachments > 1 ? "s" : ""}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
          {!atBottom && (
            <button
              onClick={jumpToBottom}
              className="absolute bottom-3 right-4 p-2.5 md:p-2 rounded-full bg-(--color-panel3) border border-(--color-border2) text-(--color-dim) hover:text-white shadow-lg dw-pop"
              title="Jump to latest"
              aria-label="Jump to latest"
            >
              <ArrowDown size={16} />
            </button>
          )}
          {branchView && (
            <BranchView
              key={branchView.query}
              sessionId={sessionId}
              query={branchView.query}
              label={branchView.label}
              onClose={() => setBranchView(null)}
              onFork={forkAt}
            />
          )}
          </ThoughtExpandCtx.Provider>
          </PlanMetaCtx.Provider>
        </div>
        {panel !== "chat" && (
          <ResizablePanel key={panel} tab={panel}>
            {panel === "files" && <FileExplorer key={cwd} cwd={cwd} sessionId={sessionId} />}
            {panel === "changes" && <ChangesPanel sessionId={sessionId} onOpenChat={() => setPanel("chat")} />}
            {panel === "terminal" && <TerminalPanel sessionId={sessionId} cwd={cwd} discovered={state.terminalIds} />}
            {panel === "history" && (
              <HistoryPanel
                sessionId={sessionId}
                onOpen={(query, label) => {
                  setBranchView({ query, label });
                  setPanel("chat"); // the overlay covers the chat column — mobile needs the chat tab visible
                }}
              />
            )}
            {panel === "plan" && (
              <PlanPanel
                items={items}
                historyTruncated={!!state.historyTruncated}
                loadingOlder={loadingOlder}
                onLoadOlder={loadOlderClick}
                onJump={jumpToItem}
                // like HistoryPanel's onOpen — the panel covers the chat
                // column on mobile, so a jump must bring the chat back
                onOpenChat={() => setPanel("chat")}
              />
            )}
          </ResizablePanel>
        )}
      </div>

      {/* plan strip — pinned above the status bar while a plan is live */}
      <PlanMetaCtx.Provider value={planMeta}>
        <PlanDock
          key={sessionId}
          items={items}
          running={state.running}
          onJump={jumpToItem}
          sessionId={sessionId}
        />
      </PlanMetaCtx.Provider>

      {/* persistent activity status — visible regardless of scroll position */}
      {(state.running || state.queued > 0) && (
        <StatusBar
          state={state}
          items={items}
          bypass={bypass}
          onEditQueued={editQueued}
          onDropQueued={dropQueued}
          onSendQueued={sendQueued}
        />
      )}

      {/* input */}
      <ChatInput sessionId={sessionId} cwd={cwd} state={state} />
    </div>
  );
}
