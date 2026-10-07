"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize2, Pencil, Pin, PinOff, Plus, RefreshCw, X } from "lucide-react";
import { api } from "@/lib/client/api";
import { connId, onServerRestart, sendTerminalInput, streamSub } from "@/lib/client/stream";
import { planTerminalWrite } from "@/lib/client/terminalCursor";
import { useToast } from "./Toasts";

interface TerminalInfo {
  id: string;
  sessionId: string;
  cwd: string;
  label: string;
  exited: boolean;
  exitCode: number | null;
  createdAt: number;
  user: boolean;
  tombstone: boolean;
  keep?: boolean;
  lastActivity?: number;
  idleMs?: number;
}

/** Key-bar catalog — users pick a subset; the selection persists in
 *  localStorage so the bar fits their shell habits (F11). */
const TERM_KEY_CATALOG: { id: string; label: string; seq: string }[] = [
  { id: "esc", label: "Esc", seq: "\x1b" },
  { id: "tab", label: "Tab", seq: "\t" },
  { id: "left", label: "←", seq: "\x1b[D" },
  { id: "down", label: "↓", seq: "\x1b[B" },
  { id: "up", label: "↑", seq: "\x1b[A" },
  { id: "right", label: "→", seq: "\x1b[C" },
  { id: "pgup", label: "PgUp", seq: "\x1b[5~" },
  { id: "pgdn", label: "PgDn", seq: "\x1b[6~" },
  { id: "home", label: "Home", seq: "\x1b[H" },
  { id: "end", label: "End", seq: "\x1b[F" },
  { id: "ctrlc", label: "^C", seq: "\x03" },
  { id: "ctrld", label: "^D", seq: "\x04" },
  { id: "ctrlz", label: "^Z", seq: "\x1a" },
  { id: "ctrll", label: "^L", seq: "\x0c" },
];

const DEFAULT_TERM_KEYS = ["esc", "tab", "left", "down", "up", "right", "ctrlc", "ctrld"];

interface Props {
  sessionId: string;
  cwd?: string;
  /** terminal ids discovered from session events (agent terminals). */
  discovered?: string[];
}

export default function TerminalPanel(props: Props) {
  // Session changes destroy the old view in the same commit, before any new
  // list request completes. Terminal ids and input handlers belong to this key.
  return <SessionTerminalPanel key={props.sessionId} {...props} />;
}

function SessionTerminalPanel({ sessionId, cwd, discovered = [] }: Props) {
  const toast = useToast();
  const [info, setInfo] = useState<Map<string, TerminalInfo>>(new Map());
  const [active, setActive] = useState<string | null>(null);
  /** tabs the user closed — stay hidden even though session events still
   *  list their ids */
  const [closed, setClosed] = useState<Set<string>>(() => new Set());

  const lifetime = useRef<AbortController | null>(null);
  const refreshSeq = useRef(0);
  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  // server-authoritative tab list — survives reloads; `user`/`tombstone`
  // flags distinguish my shells from agent terminals and released ones.
  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const seq = ++refreshSeq.current;
    try {
      const r = await api<{ terminals: TerminalInfo[] }>(
        `/api/terminals?sessionId=${encodeURIComponent(sessionId)}`,
        { signal },
      );
      if (signal.aborted || seq !== refreshSeq.current) return;
      setInfo(new Map(r.terminals.filter((t) => t.sessionId === sessionId).map((t) => [t.id, t])));
    } catch {
      /* keep stale */
    }
  }, [sessionId]);

  useEffect(() => {
    queueMicrotask(() => void refresh());
    const t = setInterval(refresh, 5000); // exited/tombstone flags change outside our view
    // a restarted server has no terminals from before — refetch the list now
    const off = onServerRestart(() => void refresh());
    return () => {
      clearInterval(t);
      off();
    };
  }, [refresh, discovered.length]);

  // union: pool terminals for this session + ids seen in session events
  const all = [...new Set([...info.keys(), ...discovered])].filter((id) => !closed.has(id));

  // fall back to the last known terminal when the active one disappears —
  // adjusted during render (state derived from props/pool state)
  if ((!active || !all.includes(active)) && all.length) setActive(all[all.length - 1]);

  const spawn = async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const r = await api<{ terminalId: string }>("/api/terminals", {
        method: "POST",
        body: JSON.stringify({ cwd, sessionId }),
      });
      if (signal.aborted) return;
      setActive(r.terminalId);
      void refresh();
    } catch (e) {
      if (signal.aborted) return;
      toast(`New shell failed: ${(e as Error).message}`);
    }
  };

  const close = async (id: string) => {
    setClosed((c) => new Set(c).add(id));
    await api(`/api/terminals/${id}`, { method: "DELETE" }).catch(() => {});
    void refresh();
  };

  const setKeep = async (id: string, keep: boolean) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      await api(`/api/terminals/${id}`, { method: "PATCH", body: JSON.stringify({ keep }) });
      void refresh();
    } catch (e) {
      if (signal.aborted) return;
      toast(`Couldn't ${keep ? "pin" : "unpin"} the shell: ${(e as Error).message}`);
    }
  };
  const activeInfo = active ? info.get(active) : undefined;
  const showKeep = !!activeInfo?.user && !activeInfo.exited && !activeInfo.tombstone;

  // stable callback — a fresh closure each render would remount xterm
  const onTermEvent = useCallback(() => void refresh(), [refresh]);

  const tabLabel = (id: string) => {
    const t = info.get(id);
    return t?.label || id.split("-").slice(0, 2).join("-");
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-(--color-code-bg)">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-(--color-border) overflow-x-auto">
        {all.map((id) => {
          const t = info.get(id);
          return (
            <span
              key={id}
              className={`group flex items-center gap-1 rounded text-xs mono shrink-0 ${
                active === id ? "bg-(--color-panel2) text-white" : "text-(--color-dim)"
              }`}
            >
              <button
                onClick={() => setActive(id)}
                className="px-2 py-2 md:py-1 hover:text-white"
                title={t ? `${t.label} — ${t.cwd}` : id}
              >
                {t?.keep && <Pin size={10} className="inline -rotate-45 mr-1 text-(--color-accent)" aria-label="Kept open" />}
                {tabLabel(id)}
                {t?.exited && <span className="ml-1 text-(--color-dim)">⏹{t.exitCode != null ? t.exitCode : ""}</span>}
              </button>
              <button
                onClick={() => void close(id)}
                className="pr-2 pl-0.5 py-2 md:py-1 md:pr-1.5 -ml-1 opacity-60 hover:opacity-100 hover:text-(--color-red)"
                title={t && !t.user && !t.exited ? "Hide tab — the command keeps running" : "Close terminal"}
                aria-label={t && !t.user && !t.exited ? "Hide terminal tab" : "Close terminal"}
              >
                <X size={12} />
              </button>
            </span>
          );
        })}
        <button onClick={() => void spawn()} className="p-1.5 text-(--color-dim) hover:text-white" title="New shell">
          <Plus size={14} />
        </button>
        <button onClick={() => void refresh()} className="p-1.5 text-(--color-dim) hover:text-white" title="Refresh">
          <RefreshCw size={12} />
        </button>
        {all.length === 0 && (
          <span className="text-xs text-(--color-dim) px-2">No terminals — agent execs and your shells appear here.</span>
        )}
      </div>
      {showKeep && activeInfo && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-(--color-border) text-2xs text-(--color-dim)">
          <span className="flex-1 min-w-0 truncate">
            {activeInfo.keep
              ? "Kept open — this shell won't close when idle."
              : `Closes after ${Math.round((activeInfo.idleMs ?? 1_800_000) / 60000)}m idle while no tab is watching it.`}
          </span>
          <button
            onClick={() => void setKeep(activeInfo.id, !activeInfo.keep)}
            className="flex items-center gap-1 px-2 py-1.5 md:py-1 rounded border border-(--color-border2) text-(--color-text) hover:bg-(--color-panel2) shrink-0"
          >
            {activeInfo.keep ? <PinOff size={12} /> : <Pin size={12} />}
            {activeInfo.keep ? "Allow idle close" : "Keep open"}
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 relative">
        {/* Only the active terminal mounts xterm — others stay as tabs. */}
        {active && all.includes(active) && <TerminalView key={active} terminalId={active} onEvent={onTermEvent} />}
      </div>
    </div>
  );
}

function TerminalView({ terminalId, onEvent }: { terminalId: string; onEvent?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  // sticky Ctrl — armed via the key bar, consumed by the next typed char
  const ctrlRef = useRef(false);
  const fitHere = useRef<(() => void) | null>(null);
  const [ctrl, setCtrl] = useState(false);
  const armCtrl = () => {
    ctrlRef.current = !ctrlRef.current;
    setCtrl(ctrlRef.current);
  };

  useLayoutEffect(() => {
    let disposed = false;
    let unsub: (() => void) | null = null;
    let disposeTerm: (() => void) | null = null;
    // safety net: if init throws after open() but before disposeTerm is
    // wired, the cleanup still has something to dispose
    let opened: { dispose(): void } | null = null;
    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      await import("@xterm/xterm/css/xterm.css");
      if (disposed || !hostRef.current) return;

      const term = new Terminal({
        convertEol: false,
        fontSize: 12,
        theme: {
          // single theme, read once at mount — keeps xterm's canvas in
          // sync with the --color-term token instead of a stray hex
          background:
            getComputedStyle(document.documentElement).getPropertyValue("--color-term").trim() ||
            "#0b0e14",
        },
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      opened = term;
      fit.fit();
      const sendResize = (cols: number, rows: number, claim = false) => {
        if (disposed) return;
        void api(`/api/terminals/${terminalId}/resize`, {
          method: "POST",
          // connId → only the oldest attached viewer actually resizes the PTY
          body: JSON.stringify({ cols, rows, c: connId, claim }),
        }).catch(() => {});
      };
      sendResize(term.cols, term.rows);
      fitHere.current = () => {
        fit.fit();
        sendResize(term.cols, term.rows, true);
      };
      const resizeDisposable = term.onResize(({ cols, rows }) => sendResize(cols, rows));

      // mux subscription — snapshot+subscription are atomic server-side, and
      // reconnects replay from a byte cursor (full resync when it aged out),
      // so no output can slip between snapshot and stream anymore.
      let cursor = 0;
      unsub = streamSub("terminal", terminalId, (msg) => {
        try {
          // full snapshot → replace; partial snapshot / live data → append
          // past the byte cursor (see lib/client/terminalCursor)
          const plan = planTerminalWrite(cursor, msg);
          cursor = plan.cursor;
          if (plan.action.kind === "reset") {
            term.reset();
            if (plan.action.text) term.write(plan.action.text);
          } else if (plan.action.kind === "append") {
            term.write(plan.action.text);
          }
          if (typeof msg.snapshot === "string") {
            if (msg.exited) onEvent?.();
            return;
          }
          if (typeof msg.data === "string") return;
          if (msg.event) {
            const e = msg.event as { type: string; exitCode?: number | null; signal?: string | null };
            if (e.type === "exit")
              term.write(`\r\n\x1b[90m[process exited${e.exitCode != null ? ` (${e.exitCode})` : ""}${e.signal ? ` — ${e.signal}` : ""}]\x1b[0m\r\n`);
            else if (e.type === "released") term.write(`\r\n\x1b[90m[terminal released]\x1b[0m\r\n`);
            onEvent?.();
          }
        } catch {
          /* noop */
        }
      });
      term.onData((data) => {
        if (disposed) return;
        // sticky Ctrl turns the next letter into its control character
        if (ctrlRef.current && data.length === 1) {
          const c = data.toLowerCase().charCodeAt(0);
          if (c >= 97 && c <= 122) {
            ctrlRef.current = false;
            setCtrl(false);
            sendTerminalInput(terminalId, String.fromCharCode(c - 96));
            return;
          }
        }
        sendTerminalInput(terminalId, data);
      });

      const onResize = () => fit.fit();
      window.addEventListener("resize", onResize);
      // fit on host resizes too (panel toggles, sidebar open) — window resize misses those
      const ro = new ResizeObserver(() => fit.fit());
      ro.observe(hostRef.current);
      disposeTerm = () => {
        window.removeEventListener("resize", onResize);
        ro.disconnect();
        resizeDisposable.dispose();
        unsub?.();
        if (opened) {
          opened = null;
          term.dispose();
        }
      };
      // unmounted mid-init — clean up what exists so far
      if (disposed) disposeTerm();
    })();
    return () => {
      disposed = true;
      unsub?.();
      disposeTerm?.();
      opened?.dispose();
      opened = null;
    };
  }, [terminalId, onEvent]);

  const send = (seq: string) => sendTerminalInput(terminalId, seq);
  const [editing, setEditing] = useState(false);
  const [keyIds, setKeyIds] = useState<string[]>(DEFAULT_TERM_KEYS);
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("dw-term-keys") ?? "null") as string[] | null;
      if (Array.isArray(stored) && stored.length) {
        queueMicrotask(() => setKeyIds(stored.filter((id) => TERM_KEY_CATALOG.some((k) => k.id === id))));
      }
    } catch {
      /* corrupt/absent */
    }
  }, []);
  const keys = TERM_KEY_CATALOG.filter((k) => keyIds.includes(k.id));
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-1 px-1.5 py-1 border-b border-(--color-border) overflow-x-auto shrink-0">
        <button
          onClick={armCtrl}
          className={`px-2 py-1 rounded mono text-2xs shrink-0 ${
            ctrl ? "bg-(--color-accent) text-black" : "bg-(--color-panel2) text-(--color-dim)"
          }`}
          title="Sticky Ctrl — next letter becomes Ctrl+letter"
        >
          Ctrl
        </button>
        {keys.map((k) => (
          <button
            key={k.id}
            onClick={() => send(k.seq)}
            className="px-2 py-1 rounded mono text-2xs bg-(--color-panel2) text-(--color-dim) hover:text-white shrink-0"
          >
            {k.label}
          </button>
        ))}
        <button
          onClick={() => fitHere.current?.()}
          className="p-1.5 rounded text-(--color-dim) hover:text-white shrink-0"
          title="Fit the terminal to this window (take over resize)"
        >
          <Maximize2 size={11} />
        </button>
        <button
          onClick={() => setEditing((v) => !v)}
          className="ml-auto p-1.5 rounded text-(--color-dim) hover:text-white shrink-0"
          title="Customize key bar"
          aria-expanded={editing}
        >
          <Pencil size={11} />
        </button>
      </div>
      {editing && (
        <div className="flex flex-wrap items-center gap-1 px-1.5 py-1.5 border-b border-(--color-border) shrink-0">
          {TERM_KEY_CATALOG.map((k) => {
            const on = keyIds.includes(k.id);
            return (
              <button
                key={k.id}
                onClick={() =>
                  setKeyIds((ids) => {
                    const next = on ? ids.filter((i) => i !== k.id) : [...ids, k.id];
                    try {
                      localStorage.setItem("dw-term-keys", JSON.stringify(next.length ? next : DEFAULT_TERM_KEYS));
                    } catch {
                      /* quota */
                    }
                    return next.length ? next : ids;
                  })
                }
                className={`px-2 py-0.5 rounded mono text-tiny border shrink-0 ${
                  on
                    ? "border-(--color-accent) text-(--color-accent)"
                    : "border-(--color-border) text-(--color-faint)"
                }`}
                aria-pressed={on}
              >
                {k.label}
              </button>
            );
          })}
        </div>
      )}
      <div className="flex-1 min-h-0 relative">
        <div ref={hostRef} className="xterm-container absolute inset-0" />
      </div>
    </div>
  );
}
