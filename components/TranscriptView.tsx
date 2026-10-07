"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

interface Props {
  session: SessionInfo;
  jump?: JumpTarget | null;
  onRetry: () => void;
  onTakeover?: () => void;
  onOpenSidebar?: () => void;
}

export default function TranscriptView(props: Props) {
  // State and cursors are owned by one session lifetime, including A → B → A.
  return <SessionTranscriptView key={props.session.sessionId} {...props} />;
}

function SessionTranscriptView({ session, jump, onRetry, onTakeover, onOpenSidebar }: Props) {
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
  const jumpDone = useRef<JumpTarget | null>(null);
  const jumpPages = useRef<{ target: JumpTarget; count: number } | null>(null);
  const [jumpError, setJumpError] = useState<{ target: JumpTarget; message: string } | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const pendingLoad = useRef<AbortSignal | null>(null);
  const windowVersion = useRef(0);
  const olderRequest = useRef<{ controller: AbortController; target?: JumpTarget } | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      olderRequest.current?.controller.abort();
    };
  }, []);
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

  // Serialize REST polls so two baseline/delta responses cannot arrive out
  // of order and regress either the displayed window or its REST cursor.
  const load = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pendingLoad.current === signal) return;
    pendingLoad.current = signal;
    const after = lastId.current;
    try {
      const r = await api<{ items: TranscriptItem[]; truncated: boolean; reset?: boolean }>(
        `/api/sessions/${session.sessionId}/transcript${after ? `?after=${after}` : ""}`,
        { signal },
      );
      if (signal.aborted) return;
      if (r.reset || after === 0) {
        windowVersion.current++;
        olderRequest.current?.controller.abort();
        olderRequest.current = null;
        shift.current = null;
        setLoadingOlder(false);
        setItems(r.items);
        setTruncated(r.truncated);
        lastId.current = 0;
      } else if (r.items.length) {
        merge(r.items);
        if (baseLoaded.current) markActivity();
      }
      baseLoaded.current = true;
      const tail = r.items[r.items.length - 1];
      if (tail?.id) lastId.current = Math.max(lastId.current, tail.id);
      setErr(null);
    } catch (e) {
      if (!signal.aborted) setErr((e as Error).message);
    } finally {
      if (pendingLoad.current === signal) pendingLoad.current = null;
    }
  }, [session.sessionId, merge, markActivity]);

  // near-live: the mux stream pushes new items on every db commit (no refetch
  // roundtrip). The server-side transcript cursor resyncs itself on reconnect,
  // so only the REST fallback poll remains for belt-and-suspenders coverage.
  useEffect(() => {
    const signal = lifetime.current!.signal;
    // subscribe first — the baseline REST query then covers rows committed
    // before the stream's tip, so nothing falls in the REST↔tip gap
    const unsub = streamSub("transcript", session.sessionId, (msg) => {
      // server pushes {kind:"transcript", type:"items", items, lastId}
      if (!signal.aborted && Array.isArray(msg.items)) {
        merge(msg.items as TranscriptItem[]);
        markActivity();
      }
    });
    queueMicrotask(() => void load());
    const unsubState = onStreamState((ok) => {
      if (signal.aborted) return;
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

  // A page belongs to both the session lifetime and the baseline window.
  // A full REST reset invalidates pages requested against the old window.
  const loadOlder = useCallback(async (target?: JumpTarget) => {
    const first = items?.find((i) => i.id != null);
    const signal = lifetime.current?.signal;
    if (!first?.id || !signal || signal.aborted || olderRequest.current) return false;
    const request = { controller: new AbortController(), target };
    olderRequest.current = request;
    const version = windowVersion.current;
    const el = scrollRef.current;
    if (el) shift.current = el.scrollHeight - el.scrollTop;
    setLoadingOlder(true);
    try {
      const r = await api<{ items: TranscriptItem[]; truncated: boolean }>(
        `/api/sessions/${session.sessionId}/transcript?before=${first.id}&tail=50`,
        { signal: request.controller.signal },
      );
      if (signal.aborted || request.controller.signal.aborted || version !== windowVersion.current) return false;
      setItems((prev) => {
        const have = new Set((prev ?? []).map((i) => i.id));
        return [...r.items.filter((i) => i.id == null || !have.has(i.id)), ...(prev ?? [])];
      });
      setTruncated(r.truncated);
      setErr(null);
      const progress = r.items.some((i) => i.id != null && i.id < first.id!);
      if (target && !progress) {
        jumpDone.current = target;
        setJumpError({ target, message: "Search result not found in the loaded history." });
      }
      return progress;
    } catch (e) {
      if (!signal.aborted && !request.controller.signal.aborted) {
        setErr((e as Error).message);
        if (target) {
          jumpDone.current = target;
          setJumpError({ target, message: "Search result not found in the loaded history." });
        }
      }
      return false;
    } finally {
      if (!signal.aborted && olderRequest.current === request) {
        olderRequest.current = null;
        setLoadingOlder(false);
      }
    }
  }, [items, scrollRef, session.sessionId]);

  // A new pick cancels only pages issued for the previous pick; manual
  // pagination can still finish. Unmount also aborts all page requests.
  useEffect(() => () => {
    const request = olderRequest.current;
    if (request && jump && request.target === jump) {
      request.controller.abort();
      olderRequest.current = null;
      shift.current = null;
      setLoadingOlder(false);
    }
  }, [jump]);

  useEffect(() => {
    if (!jump || items == null || jumpDone.current === jump) return;
    if (jumpPages.current?.target !== jump) jumpPages.current = { target: jump, count: 0 };
    const target = jump.nodeId != null
      ? items.find((m) => m.id === jump.nodeId)
      : items.find((m) => anchorMatch(m.text, jump.anchor));
    if (target?.id != null) {
      unpin();
      const frame = requestAnimationFrame(() => {
        jumpDone.current = jump;
        document.getElementById(`msg-${target.id}`)?.scrollIntoView({ block: "center" });
        setFlash(target.id!);
      });
      return () => cancelAnimationFrame(frame);
    }
    const first = items.find((m) => m.id != null);
    const canPage = jump.nodeId != null && first?.id != null && jump.nodeId < first.id && truncated;
    if (canPage && jumpPages.current.count < 20) {
      if (loadingOlder || olderRequest.current) return;
      jumpPages.current.count++;
      void loadOlder(jump);
      return;
    }
    jumpDone.current = jump;
    queueMicrotask(() => setJumpError({ target: jump, message: "Search result not found in the loaded history." }));
  }, [jump, items, truncated, loadingOlder, loadOlder, unpin]);

  useEffect(() => {
    if (shift.current == null || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight - shift.current;
    shift.current = null;
  }, [items, scrollRef]);

  useEffect(() => {
    if (flash == null) return;
    const timer = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(timer);
  }, [flash]);

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
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className="self-center text-xs text-(--color-dim) hover:text-white px-3 py-1 rounded-full border border-(--color-border) hover:bg-(--color-panel2) disabled:opacity-50"
              >
                {loadingOlder ? "Loading…" : "Load earlier messages"}
              </button>
            )}
            {jumpError && jumpError.target === jump && <div role="status" className="text-(--color-dim) text-sm">{jumpError.message}</div>}
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
