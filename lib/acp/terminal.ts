import { appendOutput, tailWithin, trimTo, utf8Boundary } from "./outputBuffer.mjs";
import type { IPty } from "node-pty";
import type { TerminalCreateRequest } from "./types";
import { RemoteTerminalPool } from "./terminal-remote";

const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 6: "SIGABRT", 9: "SIGKILL",
  13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM", 17: "SIGCHLD", 19: "SIGSTOP",
};

export function signalName(n: number | undefined | null): string | null {
  if (n == null || n === 0) return null;
  return SIGNAL_NAMES[n] ?? `SIG${n}`;
}

export { utf8Boundary } from "./outputBuffer.mjs";

export interface TerminalEvent {
  type: "exit" | "released";
  exitCode?: number | null;
  signal?: string | null;
}

/** Output handed to a (re)subscribing viewer. `partial` = only the tail after
 *  the viewer's cursor (append it); otherwise the full retained output
 *  (replace the view). */
export interface TermSnapshot {
  output: string;
  offset: number;
  truncated: boolean;
  exited: boolean;
  resynced: boolean;
  partial: boolean;
}

interface TerminalEntry {
  pty: IPty | null; // null after release (tombstone keeps last output)
  output: string;
  /** byte length of `output` (string.length is UTF-16 units, not bytes) */
  outputBytes: number;
  /** total bytes ever trimmed from the front — output[i] sits at absolute
   *  offset baseOffset+i, so subscribers resync by byte cursor */
  baseOffset: number;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  exited: boolean;
  exitedAt: number | null;
  waiters: ((r: { exitCode: number | null; signal: string | null }) => void)[];
  outputByteLimit: number;
  listeners: Set<(data: string, endOffset: number) => void>;
  eventListeners: Set<(e: TerminalEvent) => void>;
  sessionId: string;
  cwd: string;
  label: string;
  createdAt: number;
  /** user-spawned shells (POST /api/terminals) are reaped when idle */
  user: boolean;
  /** last I/O (input or output) — drives idle reaping */
  lastActivity: number;
  /** user pinned it — exempt from idle reaping */
  keep: boolean;
  /** the user closed this tab — hidden from list(), output kept for the agent */
  dismissed?: boolean;
  /** attached viewer connIds, oldest first — viewers[0] owns PTY resize so
   *  multiple clients can't fight over cols/rows */
  viewers: string[];
  /** per-connection ordered input state: connId → next expected seq / buffer */
  inputSeq: Map<string, { next: number; pending: Map<number, string>; timer: ReturnType<typeof setTimeout> | null }>;
}

/** Reap user shells with no I/O and no attached viewers for this long. */
export const USER_IDLE_MS = 30 * 60 * 1000;
/** Exited-but-never-released terminals (the agent forgot terminal/release)
 *  are tombstoned after this — their pty handle and full output otherwise
 *  live forever. */
export const EXITED_TTL_MS = 10 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

export interface TerminalInfo {
  id: string;
  sessionId: string;
  cwd: string;
  label: string;
  exited: boolean;
  exitCode: number | null;
  createdAt: number;
  /** user-spawned shell (POST /api/terminals) vs agent-owned */
  user: boolean;
  /** released but kept as tombstone (last output still viewable) */
  tombstone: boolean;
  /** user shell pinned against the idle reaper */
  keep?: boolean;
  /** last I/O (epoch ms) and the idle limit — the UI shows when an
   *  unwatched user shell would close */
  lastActivity?: number;
  idleMs?: number;
}

class TerminalPool {
  private terms = new Map<string, TerminalEntry>();
  private seq = 0;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  create(
    req: TerminalCreateRequest,
    onOutput: (terminalId: string, data: string) => void,
    opts?: { user?: boolean },
  ): { terminalId: string } {
    // node-pty is a native module; require lazily so the web app still boots without it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pty = require("node-pty") as typeof import("node-pty");
    const id = `term-${++this.seq}-${Date.now().toString(36)}`;
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    for (const e of req.env ?? []) env[e.name] = e.value;

    // ACP sends the command as a shell string ("echo hi") — run it via the
    // user's shell when no explicit argv is provided.
    const useShell = !req.args || req.args.length === 0;
    const cmd = useShell ? process.env.SHELL || "/bin/bash" : req.command;
    const argv = useShell ? ["-c", req.command] : req.args!;

    const proc = pty.spawn(cmd, argv, {
      name: "xterm-256color",
      cwd: req.cwd || process.cwd(),
      env,
      cols: 120,
      rows: 30,
    });

    const entry: TerminalEntry = {
      pty: proc,
      output: "",
      outputBytes: 0,
      baseOffset: 0,
      truncated: false,
      exitCode: null,
      signal: null,
      exited: false,
      exitedAt: null,
      waiters: [],
      outputByteLimit: req.outputByteLimit ?? 512 * 1024,
      listeners: new Set(),
      eventListeners: new Set(),
      sessionId: req.sessionId ?? "",
      cwd: req.cwd || process.cwd(),
      label: req.command.split("\n")[0].slice(0, 60),
      createdAt: Date.now(),
      user: opts?.user === true,
      lastActivity: Date.now(),
      viewers: [],
      inputSeq: new Map(),
      keep: false,
    };

    this.startSweeper();

    proc.onData((data) => {
      entry.lastActivity = Date.now();
      appendOutput(entry, data, entry.outputByteLimit);
      onOutput(id, data);
      for (const fn of entry.listeners) fn(data, entry.baseOffset + entry.outputBytes);
    });
    proc.onExit(({ exitCode, signal }) => {
      entry.exited = true;
      entry.exitedAt = Date.now();
      entry.exitCode = exitCode;
      entry.signal = signalName(signal);
      for (const w of entry.waiters.splice(0)) w({ exitCode, signal: signalName(signal) });
      for (const fn of entry.eventListeners) fn({ type: "exit", exitCode, signal: signalName(signal) });
      onOutput(id, "");
    });
    this.terms.set(id, entry);
    return { terminalId: id };
  }

  output(terminalId: string) {
    const t = this.terms.get(terminalId);
    if (!t) throw new Error(`unknown terminal ${terminalId}`);
    return {
      output: tailWithin(t, t.outputByteLimit),
      truncated: t.truncated || t.outputBytes > t.outputByteLimit,
      exitStatus: t.exited ? { exitCode: t.exitCode, signal: t.signal } : null,
    };
  }

  waitForExit(terminalId: string): Promise<{ exitCode: number | null; signal: string | null }> {
    const t = this.terms.get(terminalId);
    if (!t) throw new Error(`unknown terminal ${terminalId}`);
    if (t.exited) return Promise.resolve({ exitCode: t.exitCode, signal: t.signal });
    return new Promise((r) => t.waiters.push(r));
  }

  kill(terminalId: string) {
    this.terms.get(terminalId)?.pty?.kill();
  }

  release(terminalId: string) {
    const t = this.terms.get(terminalId);
    if (!t) return;
    try {
      if (!t.exited) t.pty?.kill();
    } catch {
      /* already dead */
    }
    // Keep a tombstone (last output) for 5 min so the UI can still show it.
    t.pty = null;
    t.exited = true;
    t.exitedAt = t.exitedAt ?? Date.now();
    t.listeners.clear();
    // answer pending terminal/wait_for_exit requests instead of dropping
    // them — a released terminal must not leave the agent hanging forever
    for (const w of t.waiters.splice(0)) w({ exitCode: t.exitCode, signal: t.signal });
    trimTo(t, 64 * 1024);
    for (const fn of t.eventListeners) fn({ type: "released" });
    setTimeout(() => this.terms.delete(terminalId), 5 * 60 * 1000).unref();
  }

  /** The user closed the tab: hide it from list() immediately. A live
   *  agent-owned terminal is NOT released — that would kill the agent's
   *  process mid-turn and strand its wait_for_exit. User shells and already
   *  exited terminals can be released safely (tombstone keeps last output). */
  dismiss(terminalId: string) {
    const t = this.terms.get(terminalId);
    if (!t) return;
    if (t.pty && (t.user || t.exited)) this.release(terminalId);
    t.dismissed = true;
  }

  /** Atomic snapshot+subscribe: registers the listener and returns the current
   *  output + absolute base offset in one synchronous step, so no pty output
   *  can slip between a separate snapshot fetch and subscribe (2-10).
   *  `since` (absolute byte offset) replays only the missed tail. */
  attach(
    terminalId: string,
    onData: (data: string, endOffset: number) => void,
    onEvent: (e: TerminalEvent) => void,
    since?: number,
    connId?: string,
  ): TermSnapshot | null {
    const t = this.terms.get(terminalId);
    if (!t) return null;
    t.listeners.add(onData);
    t.eventListeners.add(onEvent);
    // first attached viewer owns PTY resize — extra clients only watch
    if (connId && !t.viewers.includes(connId)) t.viewers.push(connId);
    return this.snapshot(terminalId, since);
  }

  /** Read-only resync: output beyond `since` without adding listeners. A cursor
   *  older than what we still hold gets the full output (resynced). */
  snapshot(terminalId: string, since?: number): TermSnapshot | null {
    const t = this.terms.get(terminalId);
    if (!t) return null;
    if (since != null && since > t.baseOffset) {
      const b = Buffer.from(t.output, "utf8");
      const cut = utf8Boundary(b, since - t.baseOffset);
      return {
        output: b.subarray(cut).toString("utf8"),
        offset: t.baseOffset + cut,
        truncated: t.truncated,
        exited: t.exited,
        resynced: false,
        partial: true,
      };
    }
    return {
      output: t.output,
      offset: t.baseOffset,
      truncated: t.truncated,
      exited: t.exited,
      resynced: since != null && since < t.baseOffset,
      partial: false,
    };
  }

  detach(terminalId: string, onData: (data: string, endOffset: number) => void, onEvent: (e: TerminalEvent) => void) {
    const t = this.terms.get(terminalId);
    if (!t) return;
    t.listeners.delete(onData);
    t.eventListeners.delete(onEvent);
  }

  /** Its socket can't drop — nothing ever resyncs. */
  onResync(): () => void {
    return () => {};
  }

  /** Attach a live-output listener (for the browser terminal panel). */
  onData(terminalId: string, fn: (data: string, endOffset: number) => void): () => void {
    const t = this.terms.get(terminalId);
    if (!t) return () => {};
    t.listeners.add(fn);
    return () => t.listeners.delete(fn);
  }

  write(terminalId: string, data: string, connId?: string, seq?: number) {
    const t = this.terms.get(terminalId);
    if (!t) return;
    if (connId == null || seq == null) {
      t.lastActivity = Date.now();
      t.pty?.write(data);
      return;
    }
    // ordered input: apply in seq order per connection — out-of-order posts
    // are buffered briefly, then flushed sorted (a lost message must not jam)
    let st = t.inputSeq.get(connId);
    if (!st) t.inputSeq.set(connId, (st = { next: 1, pending: new Map(), timer: null }));
    if (seq < st.next) return; // duplicate / already applied
    if (seq === st.next) {
      this.applyInput(t, data);
      st.next++;
      while (st.pending.has(st.next)) {
        this.applyInput(t, st.pending.get(st.next)!);
        st.pending.delete(st.next);
        st.next++;
      }
      return;
    }
    st.pending.set(seq, data);
    if (!st.timer) {
      st.timer = setTimeout(() => {
        st.timer = null;
        // flush everything we have in order; a gap means a message was lost —
        // skipping past it is better than jamming input forever
        let last = st.next - 1;
        for (const k of [...st.pending.keys()].sort((a, b) => a - b)) {
          this.applyInput(t, st.pending.get(k)!);
          st.pending.delete(k);
          last = k;
        }
        st.next = last + 1;
      }, 150);
      st.timer.unref?.();
    }
  }

  private applyInput(t: TerminalEntry, data: string) {
    t.lastActivity = Date.now();
    t.pty?.write(data);
  }

  /** Drop a connection's ordered-input state for one terminal — called when
   *  its mux subscription ends so connIds don't accumulate in inputSeq. */
  dropConnState(terminalId: string, connId: string) {
    const t = this.terms.get(terminalId);
    if (!t) return;
    const st = t.inputSeq.get(connId);
    if (st) {
      if (st.timer) clearTimeout(st.timer);
      t.inputSeq.delete(connId);
    }
    // release resize ownership — the next viewer in line inherits it
    t.viewers = t.viewers.filter((v) => v !== connId);
  }

  /** Periodic reaper: idle user shells, plus exited terminals the agent never
   *  released. Live agent (ACP) terminals are never killed — the agent manages
   *  their lifecycle. unref'd so the sweep never holds the server open. */
  private startSweeper() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.reapIdle(), SWEEP_MS);
    this.sweeper.unref();
  }

  private reapIdle() {
    const now = Date.now();
    for (const [id, t] of this.terms) {
      if (t.exited) {
        // exited but never released (no tombstone scheduled) → release now
        if (t.pty && !t.listeners.size && now - (t.exitedAt ?? now) > EXITED_TTL_MS) {
          this.release(id);
        }
        continue;
      }
      if (!t.user || !t.pty || t.keep) continue;
      if (t.listeners.size > 0) continue; // someone is watching the stream
      if (now - t.lastActivity < USER_IDLE_MS) continue;
      appendOutput(t, `\n\x1b[33m[devin-web] idle shell closed after ${Math.round(USER_IDLE_MS / 60000)}m of inactivity\x1b[0m\n`, t.outputByteLimit);
      this.release(id); // tombstone keeps the notice + last output for the UI
    }
  }

  /** "Fit here": move this viewer to the front — it owns PTY resize until it
   *  detaches or another viewer claims (the oldest-viewer default pins a
   *  phone's small size on a desktop session otherwise). */
  claimResize(terminalId: string, connId: string) {
    const t = this.terms.get(terminalId);
    if (!t || !t.viewers.includes(connId)) return;
    t.viewers = [connId, ...t.viewers.filter((v) => v !== connId)];
  }

  resize(terminalId: string, cols: number, rows: number, connId?: string) {
    const t = this.terms.get(terminalId);
    // only the oldest attached viewer resizes the PTY — extra clients'
    // fit() calls would otherwise fight over cols/rows (F8)
    if (t && connId != null && t.viewers.length && t.viewers[0] !== connId) return;
    try {
      t?.pty?.resize(cols, rows);
    } catch {
      /* ignore */
    }
  }

  list(sessionId?: string): TerminalInfo[] {
    return [...this.terms.entries()]
      .filter(([, t]) => !t.dismissed && (!sessionId || t.sessionId === sessionId))
      .map(([id, t]) => ({
        id,
        sessionId: t.sessionId,
        cwd: t.cwd,
        label: t.label,
        exited: t.exited,
        exitCode: t.exitCode,
        createdAt: t.createdAt,
        user: t.user,
        tombstone: t.pty === null,
        keep: t.keep,
        lastActivity: t.lastActivity,
        idleMs: USER_IDLE_MS,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  setKeep(terminalId: string, keep: boolean) {
    const t = this.terms.get(terminalId);
    if (t) t.keep = keep;
  }
}

/** The pool surface both implementations satisfy. Remote calls are async;
 *  local ones stay synchronous — `await` works uniformly on either. */
export type MaybePromise<T> = T | Promise<T>;
export interface TerminalPoolApi {
  create(req: TerminalCreateRequest, onOutput: (terminalId: string, data: string) => void, opts?: { user?: boolean }): MaybePromise<{ terminalId: string }>;
  output(terminalId: string): MaybePromise<{ output: string; truncated: boolean; exitStatus: { exitCode: number | null; signal: string | null } | null }>;
  waitForExit(terminalId: string): Promise<{ exitCode: number | null; signal: string | null }>;
  kill(terminalId: string): MaybePromise<void>;
  release(terminalId: string): MaybePromise<void>;
  dismiss(terminalId: string): MaybePromise<void>;
  attach(terminalId: string, onData: (data: string, endOffset: number) => void, onEvent: (e: TerminalEvent) => void, since?: number, connId?: string): MaybePromise<TermSnapshot | null>;
  snapshot(terminalId: string, since?: number): MaybePromise<TermSnapshot | null>;
  detach(terminalId: string, onData: (data: string, endOffset: number) => void, onEvent: (e: TerminalEvent) => void): MaybePromise<void>;
  onData(terminalId: string, fn: (data: string, endOffset: number) => void): () => void;
  /** Full/resynced snapshots after a host-socket reconnect — local pool
   *  never fires it (its socket can't drop). */
  onResync(terminalId: string, fn: (snap: TermSnapshot) => void): () => void;
  write(terminalId: string, data: string, connId?: string, seq?: number): MaybePromise<void>;
  dropConnState(terminalId: string, connId: string): MaybePromise<void>;
  claimResize(terminalId: string, connId: string): MaybePromise<void>;
  resize(terminalId: string, cols: number, rows: number, connId?: string): MaybePromise<void>;
  list(sessionId?: string): MaybePromise<TerminalInfo[]>;
  /** pin/unpin a user shell against idle reaping */
  setKeep(terminalId: string, keep: boolean): MaybePromise<void>;
}

/** The in-process pool — always local regardless of DEVIN_WEB_HOST_SOCK.
 *  The facade below may proxy to the daemon; tests and spawn-mode callers
 *  pin to this instance for direct access. */
export const localPool = new TerminalPool();
const remotePool = process.env.DEVIN_WEB_HOST_SOCK
  ? new RemoteTerminalPool(process.env.DEVIN_WEB_HOST_SOCK)
  : null;
export const terminalPool: TerminalPoolApi = remotePool ?? localPool;

/** The raw host-channel client (remote mode only) — Phase 2-2+ host methods
 *  (sessions state, db_changed) live on it alongside term/*.
 *  Null when the web owns PTYs in-process (tests, DEVIN_WEB_HOST_SOCK unset). */
export function hostClient(): RemoteTerminalPool | null {
  return remotePool;
}
