import { connect, Socket } from "node:net";
import type { TerminalCreateRequest } from "./types";
import type { TermSnapshot, TerminalEvent, TerminalInfo } from "./terminal";

/** Client of the daemon's host.sock (Phase 2-1). The daemon owns the PTYs —
 *  they survive web restarts; this pool proxies the same surface the local
 *  TerminalPool exposes, over NDJSON JSON-RPC. Reconnects automatically and
 *  re-attaches subscribed terminals (a reconnect means the daemon died and
 *  respawned, in which case re-attach returns null → exit event).
 *
 *  Per-connection input ordering (connId/seq) stays HERE — the wire only
 *  ever carries already-ordered input. */

type RpcResolve = (v: unknown) => void;

interface Stream {
  listeners: Set<(data: string, endOffset: number) => void>;
  eventListeners: Set<(e: TerminalEvent) => void>;
  resyncListeners: Set<(snap: TermSnapshot) => void>;
  /** absolute byte offset the local consumers have seen through */
  endOffset: number;
  attached: boolean;
}

const enc = (m: object) => JSON.stringify(m) + "\n";

export class RemoteTerminalPool {
  private sock: Socket | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { res: RpcResolve; rej: (e: Error) => void }>();
  private streams = new Map<string, Stream>();
  private inputSeq = new Map<string, Map<string, { next: number; pending: Map<number, string>; timer: ReturnType<typeof setTimeout> | null }>>();
  private connecting: Promise<void> | null = null;
  private closed = false;
  private dbChangedListeners = new Set<() => void>();

  constructor(private sockPath: string, private rpcTimeoutMs = 10_000) {}

  private connectSocket(): Promise<void> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((res, rej) => {
      const s = connect(this.sockPath);
      const onErr = (e: Error) => {
        this.connecting = null;
        rej(e);
      };
      s.once("error", onErr);
      s.once("connect", () => {
        s.off("error", onErr);
        this.sock = s;
        this.connecting = null;
        this.wireSocket(s);
        // The host adopts on first data, not connect. Speak on every socket
        // so database pushes work even when no terminal needs reattachment.
        void this.sessionsState().catch(() => {});
        res();
      });
    });
    return this.connecting;
  }

  private wireSocket(s: Socket) {
    this.buf = ""; // a new connection cannot complete an old partial line
    s.setEncoding("utf8");
    s.on("data", (d) => {
      this.buf += d.toString("utf8");
      // offset-scan — reslicing buf per line is O(n²) on a big burst
      let off = 0;
      let i;
      while ((i = this.buf.indexOf("\n", off)) >= 0) {
        let line = this.buf.slice(off, i);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        off = i + 1;
        if (!line.trim()) continue;
        let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown> };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // malformed wire data must never kill the process
        }
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.rej(new Error(msg.error.message ?? "host error"));
          else p.res(msg.result);
          continue;
        }
        if (msg.method === "_host/term_output") {
          const p = msg.params as { id: string; data: string; endOffset: number };
          const st = this.streams.get(p.id);
          if (!st) continue;
          st.endOffset = Math.max(st.endOffset, p.endOffset);
          for (const fn of st.listeners) fn(p.data, p.endOffset);
        } else if (msg.method === "_host/term_event") {
          const p = msg.params as unknown as { id: string } & TerminalEvent;
          const st = this.streams.get(p.id);
          if (!st) continue;
          for (const fn of st.eventListeners) fn({ type: p.type, exitCode: p.exitCode, signal: p.signal });
        } else if (msg.method === "_host/db_changed") {
          for (const fn of this.dbChangedListeners) fn();
        } else if (msg.method === "_host/replaced") {
          // another web process took over — back off so we don't fight it
          this.replacedUntil = Date.now() + 30_000;
          s.destroy();
        }
      }
      this.buf = this.buf.slice(off);
    });
    s.on("error", () => {});
    s.on("close", () => this.onClose(s));
  }

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private replacedUntil = 0;

  private onClose(s: Socket) {
    if (this.sock !== s) return;
    this.sock = null;
    for (const { rej } of this.pending.values()) rej(new Error("host socket closed"));
    this.pending.clear();
    // every stream needs re-attach on the next socket
    for (const st of this.streams.values()) st.attached = false;
    if (!this.closed) this.scheduleReconnect();
  }

  /** Keep retrying until the host is back — database-change and terminal pushes
   *  must not silently die because one connect attempt failed. After a
   *  `_host/replaced` another web process owns the socket: cool down so two
   *  webs don't ping-pong it. */
  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const cooldown = Math.max(0, this.replacedUntil - Date.now());
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reattachAll().then(
        () => { this.reconnectDelay = 1000; },
        () => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
          this.scheduleReconnect();
        },
      );
    }, Math.max(this.reconnectDelay, cooldown));
    this.reconnectTimer.unref?.();
  }

  /** Socket came back — re-subscribe every terminal that still has local
   *  listeners, replaying missed output from its endOffset. A null snapshot
   *  means the daemon restarted and the PTY is gone → tell consumers. */
  private async reattachAll() {
    try {
      await this.connectSocket();
    } catch (e) {
      throw e instanceof Error ? e : new Error("host unreachable");
    }
    for (const [id, st] of this.streams) {
      if (!st.listeners.size && !st.eventListeners.size && !st.resyncListeners.size) continue;
      let snap: TermSnapshot | null;
      try {
        snap = (await this.rpc("term/attach", { id, since: st.endOffset })) as TermSnapshot | null;
      } catch {
        continue;
      }
      if (!snap) {
        for (const fn of st.eventListeners) fn({ type: "exit", exitCode: null, signal: "terminal host restarted" });
        continue;
      }
      st.attached = true;
      st.endOffset = Math.max(st.endOffset, snap.offset + Buffer.byteLength(snap.output));
      // a partial tail can go out as plain data; a full/resynced snapshot
      // needs the reset path the wire's snapshot message provides
      if (snap.partial && snap.output) {
        for (const fn of st.listeners) fn(snap.output, snap.offset + Buffer.byteLength(snap.output));
      } else if (!snap.partial) {
        for (const fn of st.resyncListeners) fn(snap);
      }
    }
  }

  private async rpc(method: string, params?: unknown): Promise<unknown> {
    await this.connectSocket();
    const id = this.nextId++;
    // term/wait_for_exit legitimately holds until the process dies — every
    // other call gets a ceiling so a hung daemon can't stall a resync
    // barrier (or anything else) forever
    const timeout = method === "term/wait_for_exit" ? 0 : this.rpcTimeoutMs;
    return new Promise((res, rej) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeout) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          rej(new Error(`host rpc ${method} timed out`));
        }, timeout);
        timer.unref?.();
      }
      this.pending.set(id, {
        res: (v: unknown) => { if (timer) clearTimeout(timer); res(v); },
        rej: (e: Error) => { if (timer) clearTimeout(timer); rej(e); },
      });
      try {
        this.sock!.write(enc({ jsonrpc: "2.0", id, method, params: params ?? {} }));
      } catch (e) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        rej(e as Error);
      }
    });
  }

  private stream(id: string): Stream {
    let st = this.streams.get(id);
    if (!st) {
      st = { listeners: new Set(), eventListeners: new Set(), resyncListeners: new Set(), endOffset: 0, attached: false };
      this.streams.set(id, st);
    }
    return st;
  }

  async create(req: TerminalCreateRequest, _onOutput: (terminalId: string, data: string) => void, opts?: { user?: boolean }) {
    const r = (await this.rpc("term/create", { ...req, user: opts?.user === true })) as { terminalId: string };
    this.stream(r.terminalId);
    return r;
  }

  async output(terminalId: string) {
    return (await this.rpc("term/get_output", { id: terminalId })) as {
      output: string;
      truncated: boolean;
      exitStatus: { exitCode: number | null; signal: string | null } | null;
    };
  }

  waitForExit(terminalId: string): Promise<{ exitCode: number | null; signal: string | null }> {
    return this.rpc("term/wait_for_exit", { id: terminalId }) as Promise<{ exitCode: number | null; signal: string | null }>;
  }

  async kill(terminalId: string) {
    await this.rpc("term/kill", { id: terminalId });
  }

  async release(terminalId: string) {
    await this.rpc("term/release", { id: terminalId });
  }

  async dismiss(terminalId: string) {
    await this.rpc("term/dismiss", { id: terminalId });
  }

  /** Attached viewer connIds per terminal, oldest first — viewers[0] owns
   *  PTY resize (the daemon sees one socket, so ownership lives here). */
  private viewers = new Map<string, string[]>();

  /** Same claim as the local pool — ownership lives here (the daemon sees one socket). */
  claimResize(terminalId: string, connId: string) {
    const v = this.viewers.get(terminalId);
    if (!v?.includes(connId)) return;
    this.viewers.set(terminalId, [connId, ...v.filter((x) => x !== connId)]);
  }

  async resize(terminalId: string, cols: number, rows: number, connId?: string) {
    const v = this.viewers.get(terminalId);
    if (connId != null && v?.length && v[0] !== connId) return;
    await this.rpc("term/resize", { id: terminalId, cols, rows });
  }

  async setKeep(terminalId: string, keep: boolean): Promise<void> {
    await this.rpc("term/keep", { id: terminalId, keep });
  }

  async list(sessionId?: string): Promise<TerminalInfo[]> {
    const r = (await this.rpc("term/list", { sessionId })) as { terminals: TerminalInfo[] };
    return r.terminals;
  }

  /** Atomic subscribe+snapshot — identical to the local pool's attach: the
   *  server registers the stream and returns the current output in one step. */
  async attach(
    terminalId: string,
    onData: (data: string, endOffset: number) => void,
    onEvent: (e: TerminalEvent) => void,
    since?: number,
    connId?: string,
  ): Promise<TermSnapshot | null> {
    const st = this.stream(terminalId);
    st.listeners.add(onData);
    if (connId) {
      const v = this.viewers.get(terminalId) ?? [];
      if (!v.includes(connId)) v.push(connId);
      this.viewers.set(terminalId, v);
    }
    st.eventListeners.add(onEvent);
    let snap: TermSnapshot | null;
    try {
      snap = (await this.rpc("term/attach", { id: terminalId, since })) as TermSnapshot | null;
    } catch (e) {
      st.listeners.delete(onData);
      st.eventListeners.delete(onEvent);
      throw e;
    }
    if (snap == null) {
      st.listeners.delete(onData);
      st.eventListeners.delete(onEvent);
      return null;
    }
    st.attached = true;
    st.endOffset = Math.max(st.endOffset, snap.offset + Buffer.byteLength(snap.output));
    return snap;
  }

  /** Resync-only path: register a snapshot listener for daemon-restart-style
   *  reconnects (full/resynced snapshots need the reset semantic). */
  onResync(terminalId: string, fn: (snap: TermSnapshot) => void): () => void {
    const st = this.stream(terminalId);
    st.resyncListeners.add(fn);
    return () => st.resyncListeners.delete(fn);
  }

  async snapshot(terminalId: string, since?: number): Promise<TermSnapshot | null> {
    return (await this.rpc("term/snapshot", { id: terminalId, since })) as TermSnapshot | null;
  }

  async detach(terminalId: string, onData: (data: string, endOffset: number) => void, onEvent: (e: TerminalEvent) => void) {
    const st = this.streams.get(terminalId);
    if (!st) return;
    st.listeners.delete(onData);
    st.eventListeners.delete(onEvent);
    if (!st.listeners.size && !st.eventListeners.size && !st.resyncListeners.size && st.attached) {
      st.attached = false;
      try {
        await this.rpc("term/detach", { id: terminalId });
      } catch {}
    }
  }

  onData(terminalId: string, fn: (data: string, endOffset: number) => void): () => void {
    const st = this.stream(terminalId);
    st.listeners.add(fn);
    return () => st.listeners.delete(fn);
  }

  async write(terminalId: string, data: string, connId?: string, seq?: number) {
    if (connId == null || seq == null) {
      try {
        await this.rpc("term/input", { id: terminalId, data });
      } catch {}
      return;
    }
    // ordered input, identical to the local pool — ordering lives HERE so the
    // wire only ever carries already-ordered input
    let perTerm = this.inputSeq.get(terminalId);
    if (!perTerm) this.inputSeq.set(terminalId, (perTerm = new Map()));
    let st = perTerm.get(connId);
    if (!st) perTerm.set(connId, (st = { next: 1, pending: new Map(), timer: null }));
    if (seq < st.next) return;
    if (seq === st.next) {
      await this.applyInput(terminalId, data);
      st.next++;
      while (st.pending.has(st.next)) {
        await this.applyInput(terminalId, st.pending.get(st.next)!);
        st.pending.delete(st.next);
        st.next++;
      }
      return;
    }
    st.pending.set(seq, data);
    if (!st.timer) {
      st.timer = setTimeout(() => {
        st.timer = null;
        void (async () => {
          let last = st!.next - 1;
          for (const k of [...st!.pending.keys()].sort((a, b) => a - b)) {
            await this.applyInput(terminalId, st!.pending.get(k)!);
            st!.pending.delete(k);
            last = k;
          }
          st!.next = last + 1;
        })();
      }, 150);
      st.timer.unref?.();
    }
  }

  private async applyInput(terminalId: string, data: string) {
    try {
      await this.rpc("term/input", { id: terminalId, data });
    } catch {}
  }

  dropConnState(terminalId: string, connId: string) {
    const st = this.inputSeq.get(terminalId)?.get(connId);
    if (st) {
      if (st.timer) clearTimeout(st.timer);
      this.inputSeq.get(terminalId)?.delete(connId);
    }
    const v = this.viewers.get(terminalId);
    if (v) this.viewers.set(terminalId, v.filter((x) => x !== connId));
  }

  // ---------- Host connection and session state ----------

  /** true once the socket is live — callers can skip daemon-only paths when
   *  the host is unreachable (tests, DEVIN_WEB_HOST_SOCK unset). */
  get available(): boolean {
    return !!this.sock && !this.sock.destroyed;
  }

  /** Stop the reconnect loop and drop the socket — tests and process
   *  shutdown. Without this a dead host keeps the retry timer alive. */
  disconnect() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.sock?.destroy();
    for (const { rej } of this.pending.values()) rej(new Error("host client disconnected"));
    this.pending.clear();
  }

  /** Phase 2-4 proxy surface: arbitrary host.sock method call. Routes that
   *  serve daemon-owned state go through this instead of duplicating the
   *  wire protocol. */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    return (await this.rpc(method, params)) as T;
  }

  /** Daemon-side session state (loaded/busy/cwd) — the E2 slice that lets a
   *  restarted web read attach state it hasn't rebuilt yet. */
  async sessionsState(): Promise<{ sessionId: string; cwd: string | null; busy: boolean; loaded: boolean }[]> {
    const r = (await this.rpc("sessions/state", {})) as {
      sessions: { sessionId: string; cwd: string | null; busy: boolean; loaded: boolean }[];
    };
    return r.sessions ?? [];
  }

  onDbChanged(fn: () => void): () => void {
    this.dbChangedListeners.add(fn);
    return () => this.dbChangedListeners.delete(fn);
  }

  /** Keep terminal and database-change subscribers connected. */
  warmup() {
    void this.connectSocket().catch(() => {});
  }
}
