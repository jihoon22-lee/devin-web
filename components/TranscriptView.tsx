"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { displayTitle } from "@/lib/client/display";
import Markdown from "./Markdown";
import { ArrowDown, ChevronDown, ChevronRight, Lock, LockOpen, Menu, RefreshCw, Wrench } from "lucide-react";
import { api } from "@/lib/client/api";
import { onStreamState, streamSub } from "@/lib/client/stream";
import { anchorMatch, type JumpTarget } from "@/lib/client/jump";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import type { SessionInfo } from "./AppShell";
import { ToolCard } from "./MessageItem";
import type { ToolCallUpdate } from "@/lib/acp/types";

export interface TranscriptItem {
  id?: number;
  /** streaming snapshots of one message share this — merge key */
  messageId?: string;
  role: "user" | "assistant" | "tool";
  text: string;
  ts: number | null;
  toolName?: string;
  toolCallId?: string;
  tool?: ToolCallUpdate;
}

export default function TranscriptView({
  session,
  jump,
  onRetry,
  onTakeover,
  onOpenSidebar,
}: {
  session: SessionInfo;
  jump?: JumpTarget | null;
  onRetry: () => void;
  onTakeover?: () => void;
  onOpenSidebar?: () => void;
}) {
  const [items, setItems] = useState<TranscriptItem[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // prepending an older page shifts rows — anchor the viewport by restoring
  // the distance-from-bottom once the render lands
  const shift = useRef<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [active, setActive] = useState(false);
  const [flash, setFlash] = useState<number | null>(null);
  const jumpDone = useRef(0);
  const { scrollRef, onScroll, atBottom, jumpToBottom, unpin } = useStickToBottom(items, session.sessionId);
  const lastId = useRef(0);
  // items actually flowing in the last ~15s → the CLI process is working
  const lastActivity = useRef(0);
  const baseLoaded = useRef(false);
  const markActivity = useCallback(() => {
    lastActivity.current = Date.now();
    setActive(true);
  }, []);

  // sqlite appends a new node per streaming snapshot of the same message —
  // replace an earlier copy with the same messageId (or the same node id when
  // a REST poll re-delivers a delta-pushed row), append truly new items.
  // lastId is advanced only by REST responses — it drives the `?after=` polls,
  // which must stay contiguous or nodes committed between the baseline query
  // and the stream's tip would be skipped forever.
  const merge = useCallback((fresh: TranscriptItem[]) => {
    setItems((prev) => {
      const out = [...(prev ?? [])];
      const idxByMsg = new Map<string, number>();
      const idxById = new Map<number, number>();
      out.forEach((it, i) => {
        if (it.messageId != null) idxByMsg.set(it.messageId, i);
        if (it.id != null) idxById.set(it.id, i);
      });
      for (const it of fresh) {
        const j =
          (it.id != null ? idxById.get(it.id) : undefined) ??
          (it.messageId != null ? idxByMsg.get(it.messageId) : undefined);
        if (j != null) out[j] = it;
        else {
          if (it.messageId != null) idxByMsg.set(it.messageId, out.length);
          if (it.id != null) idxById.set(it.id, out.length);
          out.push(it);
        }
      }
      return out;
    });
  }, []);

  // incremental: only fetch items newer than the newest node we've rendered
  const load = useCallback(
    () =>
      api<{ items: TranscriptItem[]; truncated: boolean; reset?: boolean }>(
        `/api/sessions/${session.sessionId}/transcript${lastId.current ? `?after=${lastId.current}` : ""}`,
      )
        .then((r) => {
          if (r.reset || lastId.current === 0) {
            setItems(r.items);
            setTruncated(r.truncated);
          }
          else if (r.items.length) {
            merge(r.items);
            if (baseLoaded.current) markActivity();
          }
          baseLoaded.current = true;
          const tail = r.items[r.items.length - 1];
          if (tail?.id) lastId.current = Math.max(lastId.current, tail.id);
          // Incremental replies describe only the new tail, not whether
          // older pages still exist above our current history window.
          setErr(null); // a recovered fetch must clear a stale "Failed to fetch"
        })
        .catch((e) => setErr((e as Error).message)),
    [session.sessionId, merge, markActivity],
  );

  // near-live: the mux stream pushes new items on every db commit (no refetch
  // roundtrip). The server-side transcript cursor resyncs itself on reconnect,
  // so only the REST fallback poll remains for belt-and-suspenders coverage.
  // session switch resets the view — done during render so the previous
  // transcript never shows under the new header; the effect below only
  // re-subscribes and kicks off the (async) load
  const [prevSid, setPrevSid] = useState(session.sessionId);
  if (prevSid !== session.sessionId) {
    setPrevSid(session.sessionId);
    setItems(null);
    setActive(false);
  }

  useEffect(() => {
    lastId.current = 0;
    baseLoaded.current = false;
    lastActivity.current = 0;
    // subscribe first — the baseline REST query then covers rows committed
    // before the stream's tip, so nothing falls in the REST↔tip gap
    const unsub = streamSub("transcript", session.sessionId, (msg) => {
      // server pushes {kind:"transcript", type:"items", items, lastId}
      if (Array.isArray(msg.items)) {
        merge(msg.items as TranscriptItem[]);
        markActivity();
      }
    });
    void load();
    const unsubState = onStreamState((ok) => {
      setLive(ok);
      if (ok) void load(); // recover anything missed while disconnected
    });
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 8000);
    // the "working" chip self-clears once pushes stop arriving
    const a = setInterval(() => {
      setActive(lastActivity.current > 0 && Date.now() - lastActivity.current < 15_000);
    }, 3000);
    const onVis = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      unsub();
      unsubState();
      clearInterval(t);
      clearInterval(a);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [session.sessionId, load, merge, markActivity]);

  // search-hit jump: scroll to the matched node (once per pick) and flash it
  useEffect(() => {
    if (!jump || items == null || jumpDone.current === jump.n) return;
    const target =
      (jump.nodeId != null ? items.find((m) => m.id === jump.nodeId) : undefined) ??
      items.find((m) => anchorMatch(m.text, jump.anchor));
    if (!target || target.id == null) return;
    jumpDone.current = jump.n;
    unpin();
    // wait a frame so any pending render puts the node in the DOM
    requestAnimationFrame(() => {
      document.getElementById(`msg-${target.id}`)?.scrollIntoView({ block: "center" });
      setFlash(target.id!);
      setTimeout(() => setFlash(null), 1800);
    });
  }, [jump, items, unpin]);

  // page backwards from the oldest rendered node; overlap at the seam is
  // dropped by id so a re-click can't duplicate rows
  const loadOlder = useCallback(() => {
    const first = items?.find((i) => i.id != null);
    if (!first?.id || loadingOlder) return;
    const el = scrollRef.current;
    if (el) shift.current = el.scrollHeight - el.scrollTop;
    setLoadingOlder(true);
    api<{ items: TranscriptItem[]; truncated: boolean }>(
      `/api/sessions/${session.sessionId}/transcript?before=${first.id}&tail=50`,
    )
      .then((r) => {
        setItems((prev) => {
          const have = new Set((prev ?? []).map((i) => i.id));
          return [...r.items.filter((i) => i.id == null || !have.has(i.id)), ...(prev ?? [])];
        });
        setTruncated(r.truncated);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoadingOlder(false));
  }, [items, loadingOlder, scrollRef, session.sessionId]);

  useEffect(() => {
    if (shift.current == null || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight - shift.current;
    shift.current = null;
  }, [items, scrollRef]);

  const owner = session.lockedBy;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-(--color-border) bg-(--color-panel) flex items-center gap-2 pt-[calc(0.5rem+env(safe-area-inset-top))]">
        {onOpenSidebar && (
          <button
            onClick={onOpenSidebar}
            className="md:hidden p-1.5 -ml-1 rounded-lg text-(--color-dim) hover:text-white hover:bg-(--color-panel2) shrink-0"
            title="Sessions"
          >
            <Menu size={17} />
          </button>
        )}
        <Lock size={13} className="text-(--color-status-locked) shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{displayTitle(session.title, session.sessionId)}</span>
            {live && (
              <span className="flex items-center gap-1 text-tiny text-(--color-green) shrink-0" title="Streaming transcript updates">
                <span className="w-1.5 h-1.5 rounded-full bg-(--color-green) animate-pulse" />
                live
              </span>
            )}
            {active && (
              <span className="flex items-center gap-1 text-tiny text-(--color-accent) shrink-0" title="Transcript is being written — the owning process is mid-turn">
                <span className="w-1.5 h-1.5 rounded-full bg-(--color-accent) animate-pulse" />
                working
              </span>
            )}
          </div>
          <div className="truncate text-2xs text-(--color-dim)">
            Open in {owner?.ours ? "this devin-web" : owner?.cmdline || "another process"}
            {owner?.pid ? ` (pid ${owner.pid})` : ""} — read-only
          </div>
        </div>
        {owner && !owner.ours && onTakeover && (
          <button
            onClick={onTakeover}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-(--color-panel2) text-xs text-(--color-warning) hover:bg-(--color-panel3) shrink-0"
            title={
              owner.alive
                ? "Kill the process holding this session and load it here"
                : "The holder is gone — clear the stale lock and load it here"
            }
          >
            <LockOpen size={12} /> {owner.alive ? "Take over" : "Reclaim"}
          </button>
        )}
        <button
          onClick={onRetry}
          className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-(--color-panel2) text-xs hover:bg-(--color-panel3) shrink-0"
        >
          <RefreshCw size={12} /> Open for editing
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-3 py-4">
          <div className="max-w-3xl mx-auto flex flex-col gap-2.5">
            {truncated && !items?.some((m) => m.role === "user") && (
              <div className="self-center text-center text-xs text-(--color-faint) px-3 py-1">
                Context was compressed — earlier messages live on a previous branch.
              </div>
            )}
            {truncated && (
              <button
                onClick={loadOlder}
                disabled={loadingOlder}
                className="self-center text-xs text-(--color-dim) hover:text-white px-3 py-1 rounded-full border border-(--color-border) hover:bg-(--color-panel2) disabled:opacity-50"
              >
                {loadingOlder ? "Loading…" : "Load earlier messages"}
              </button>
            )}
            {err && <div className="text-(--color-red) text-sm">{err}</div>}
            {items === null && !err && <div className="text-(--color-dim) text-sm">Loading…</div>}
            {items?.map((m, i) => (
              <div
                key={m.id ?? i}
                id={m.id != null ? `msg-${m.id}` : undefined}
                className={`dw-virt rounded-lg transition-shadow duration-500 ${flash === m.id ? "ring-2 ring-(--color-accent)" : ""}`}
              >
                <TItem m={m} />
              </div>
            ))}
            {items?.length === 0 && <div className="text-(--color-dim) text-sm">No messages.</div>}
          </div>
        </div>
        {!atBottom && (
          <button
            onClick={jumpToBottom}
            className="absolute bottom-3 right-3 p-2 rounded-full bg-(--color-panel2) border border-(--color-border) shadow-lg text-(--color-dim) hover:text-white"
            title="Jump to latest"
          >
            <ArrowDown size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

export function TItem({ m }: { m: TranscriptItem }) {
  const [open, setOpen] = useState(false);
  if (m.role === "user") {
    return (
      <div className="self-end max-w-[85%] bg-(--color-accent)/15 border border-(--color-accent)/30 rounded-xl px-3 py-2 text-sm whitespace-pre-wrap">
        {m.text}
      </div>
    );
  }
  if (m.role === "tool") {
    // rich card when tool_call_state joined (diffs, status, terminal preview);
    // otherwise a plain expandable result block
    if (m.tool) return <ToolCard tool={m.tool} />;
    return (
      <div className="border-l-2 border-(--color-border) pl-3">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-(--color-dim) hover:text-white"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Wrench size={11} /> {m.toolName || "tool"}
        </button>
        {open && <pre className="mono text-xs text-(--color-dim) whitespace-pre-wrap mt-1">{m.text.slice(0, 4000)}</pre>}
      </div>
    );
  }
  return (
    <div className="text-sm leading-relaxed">
      <Markdown>{m.text}</Markdown>
    </div>
  );
}
