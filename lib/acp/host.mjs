import { appendOutput, tailWithin, trimTo } from "./outputBuffer.mjs";
// devin-web host — Phase 2 session-host channel. Owns the terminal PTYs so a
// web restart/deploy never kills an agent exec or a user shell.
//
// Serves NDJSON JSON-RPC on host.sock (same wire shape as acp.sock):
//   requests:  term/create|input|resize|kill|release|dismiss|list|snapshot|
//              attach|detach|get_output|wait_for_exit, sessions/state
//   pushes:    _host/term_output {id,data,endOffset}
//              _host/term_event  {id,type:"exit"|"released",exitCode,signal}
//              _host/db_changed {}
//
// Single client (the web server), adopted on FIRST DATA like acp.sock — a
// bare probe never displaces the live bridge. The pool is a port of
// lib/acp/terminal.ts minus per-connection input ordering (that stays on the
// client side — the wire always carries already-ordered input).
import { createServer } from "node:net";
import { unlink, chmod, mkdir } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let ptyMod = null;
function loadPty() {
  // native module — resolved from the repo's node_modules regardless of the
  // daemon's cwd (createRequire anchors at this file)
  if (!ptyMod) ptyMod = require("node-pty");
  return ptyMod;
}

function pushLines(state, chunk) {
  state.buf += chunk;
  const out = [];
  // offset-scan — reslicing buf per line is O(n²) on a big burst
  let off = 0;
  let i;
  while ((i = state.buf.indexOf("\n", off)) >= 0) {
    let line = state.buf.slice(off, i);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    off = i + 1;
    if (line.trim()) out.push(line);
  }
  state.buf = state.buf.slice(off);
  return out;
}
const enc = (msg) => JSON.stringify(msg) + "\n";

const SIGNAL_NAMES = {
  1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 6: "SIGABRT", 9: "SIGKILL",
  13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM", 17: "SIGCHLD", 19: "SIGSTOP",
};
const signalName = (n) => (n == null || n === 0 ? null : SIGNAL_NAMES[n] ?? `SIG${n}`);

const USER_IDLE_MS = 30 * 60 * 1000;
const EXITED_TTL_MS = 10 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

class HostTerminalPool {
  constructor() {
    this.terms = new Map();
    this.seq = 0;
    this.sweeper = null;
    this.onData = null; // (id, data, endOffset) — set by the host for pushes
    this.onEvent = null; // (id, TerminalEvent)
  }

  create(req) {
    const pty = loadPty();
    const id = `term-${++this.seq}-${Date.now().toString(36)}`;
    const env = { ...process.env };
    for (const e of req.env ?? []) env[e.name] = e.value;
    const useShell = !req.args || req.args.length === 0;
    const cmd = useShell ? process.env.SHELL || "/bin/bash" : req.command;
    const argv = useShell ? ["-c", req.command] : req.args;
    const proc = pty.spawn(cmd, argv, {
      name: "xterm-256color",
      cwd: req.cwd || process.cwd(),
      env,
      cols: 120,
      rows: 30,
    });
    const entry = {
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
      streaming: 0, // refcount of client attach subscriptions
      sessionId: req.sessionId ?? "",
      cwd: req.cwd || process.cwd(),
      label: String(req.command ?? "").split("\n")[0].slice(0, 60),
      createdAt: Date.now(),
      user: req.user === true,
      lastActivity: Date.now(),
      dismissed: false,
      keep: false, // user pinned it: never idle-reaped
    };
    this.startSweeper();
    proc.onData((data) => {
      entry.lastActivity = Date.now();
      appendOutput(entry, data, entry.outputByteLimit);
      this.onData?.(id, data, entry.baseOffset + entry.outputBytes);
    });
    proc.onExit(({ exitCode, signal }) => {
      entry.exited = true;
      entry.exitedAt = Date.now();
      entry.exitCode = exitCode;
      entry.signal = signalName(signal);
      for (const w of entry.waiters.splice(0)) w({ exitCode, signal: signalName(signal) });
      this.onEvent?.(id, { type: "exit", exitCode, signal: signalName(signal) });
      this.onData?.(id, "", entry.baseOffset + entry.outputBytes);
    });
    this.terms.set(id, entry);
    return { terminalId: id };
  }

  get(id) {
    const t = this.terms.get(id);
    if (!t) throw new Error(`unknown terminal ${id}`);
    return t;
  }

  output(id) {
    const t = this.get(id);
    return {
      output: tailWithin(t, t.outputByteLimit),
      truncated: t.truncated || t.outputBytes > t.outputByteLimit,
      exitStatus: t.exited ? { exitCode: t.exitCode, signal: t.signal } : null,
    };
  }

  snapshot(id, since) {
    const t = this.terms.get(id);
    if (!t) return null;
    if (since != null && since > t.baseOffset) {
      const b = Buffer.from(t.output, "utf8");
      let cut = since - t.baseOffset;
      // same UTF-8 boundary rule as trimming — a mid-sequence cut decodes
      // to U+FFFD and the returned offsets drift from real bytes
      while (cut < b.length && (b[cut] & 0xc0) === 0x80) cut++;
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

  waitForExit(id, resolve2) {
    const t = this.get(id);
    if (t.exited) resolve2({ exitCode: t.exitCode, signal: t.signal });
    else t.waiters.push(resolve2);
  }

  kill(id) {
    this.terms.get(id)?.pty?.kill();
  }

  release(id) {
    const t = this.terms.get(id);
    if (!t) return;
    try {
      if (!t.exited) t.pty?.kill();
    } catch {}
    t.pty = null;
    t.exited = true;
    t.exitedAt = t.exitedAt ?? Date.now();
    for (const w of t.waiters.splice(0)) w({ exitCode: t.exitCode, signal: t.signal });
    trimTo(t, 64 * 1024);
    this.onEvent?.(id, { type: "released" });
    setTimeout(() => this.terms.delete(id), 5 * 60 * 1000).unref();
  }

  dismiss(id) {
    const t = this.terms.get(id);
    if (!t) return;
    if (t.pty && (t.user || t.exited)) this.release(id);
    t.dismissed = true;
  }

  resize(id, cols, rows) {
    try {
      this.terms.get(id)?.pty?.resize(cols, rows);
    } catch {}
  }

  write(id, data) {
    const t = this.terms.get(id);
    if (!t) return;
    t.lastActivity = Date.now();
    t.pty?.write(data);
  }

  list(sessionId) {
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
        keep: !!t.keep,
        lastActivity: t.lastActivity,
        idleMs: USER_IDLE_MS,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Pin a user shell so the idle reaper leaves it alone (or unpin). */
  setKeep(id, keep) {
    const t = this.terms.get(id);
    if (t) t.keep = !!keep;
  }

  startSweeper() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.reapIdle(), SWEEP_MS);
    this.sweeper.unref();
  }

  reapIdle() {
    const now = Date.now();
    for (const [id, t] of this.terms) {
      if (t.exited) {
        if (t.pty && !t.streaming && now - (t.exitedAt ?? now) > EXITED_TTL_MS) this.release(id);
        continue;
      }
      if (!t.user || !t.pty || t.keep) continue;
      if (t.streaming) continue;
      if (now - t.lastActivity < USER_IDLE_MS) continue;
      appendOutput(t, `\n\x1b[33m[devin-web] idle shell closed after ${Math.round(USER_IDLE_MS / 60000)}m of inactivity\x1b[0m\n`, t.outputByteLimit);
      this.release(id);
    }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.sockPath
 * @param {(e: object) => void} [opts.onEvent]
 * @param {null|function(): import("./wire.d.ts").HostSessionInfo[]} [opts.sessionsProvider]
 * @param {string | null} [opts.cliDir] - sessions.db location for the
 *   durable watcher (default ~/.local/share/devin/cli)
 * @param {number} [opts.slowClientCutoffBytes] - drop a client whose
 *   socket buffer exceeds this (default 8MB, same policy as the SSE cutoff)
 */
export function createHost({ sockPath, onEvent = () => {}, sessionsProvider = null, cliDir = null, slowClientCutoffBytes = 8 * 1024 * 1024 }) {
  const pool = new HostTerminalPool();
  const log = (m) => onEvent({ type: "log", message: m });
  let server = null;
  let client = null; // { sock, attached:Set<termId> }
  let dbWatchers = [];
  let dbDebounce = null;

  // sessions.db commits mean transcript deltas / session-list changes —
  // the daemon owns the durable watcher so web restarts don't miss one.
  const CLI_DIR = cliDir ?? process.env.DEVIN_CLI_DIR ?? join(homedir(), ".local", "share", "devin", "cli");
  function startDbWatch() {
    try {
      // watch the DIRECTORY — the db/-wal files may not exist yet at start
      const w = watch(CLI_DIR, { persistent: false }, (_ev, fname) => {
        if (!fname?.startsWith("sessions.db") || dbDebounce) return;
        dbDebounce = setTimeout(() => {
          dbDebounce = null;
          write({ jsonrpc: "2.0", method: "_host/db_changed", params: {} });
        }, 150);
        dbDebounce.unref?.();
      });
      dbWatchers.push(w);
    } catch {
      /* cli dir absent — the web keeps its own fallback watch */
    }
  }

  const pushOutput = (id, data, endOffset) => {
    const t = pool.terms.get(id);
    if (!t || !client || !client.attached.has(id)) return;
    write({ jsonrpc: "2.0", method: "_host/term_output", params: { id, data, endOffset } });
  };
  const pushEvent = (id, ev) => {
    if (!client || !client.attached.has(id)) return;
    write({ jsonrpc: "2.0", method: "_host/term_event", params: { id, ...ev } });
  };
  pool.onData = pushOutput;
  pool.onEvent = pushEvent;

  function write(msg) {
    if (!client) return;
    try {
      // slow consumer → drop the connection; the client reattaches and
      // replays from its byte-offset cursor instead of us buffering
      // unboundedly (same 8MB policy as the SSE cutoff)
      if (!client.sock.write(enc(msg)) && client.sock.writableLength > slowClientCutoffBytes) {
        client.sock.destroy();
      }
    } catch {}
  }

  function dropClient() {
    if (!client) return;
    for (const id of client.attached) {
      const t = pool.terms.get(id);
      if (t) t.streaming = Math.max(0, t.streaming - 1);
    }
    client = null;
  }

  function handle(msg) {
    const p = msg.params ?? {};
    switch (msg.method) {
      case "term/create":
        return { result: pool.create(p) };
      case "term/input":
        pool.write(p.id, String(p.data ?? ""));
        return { result: {} };
      case "term/resize":
        pool.resize(p.id, Number(p.cols) || 120, Number(p.rows) || 30);
        return { result: {} };
      case "term/kill":
        pool.kill(p.id);
        return { result: {} };
      case "term/release":
        pool.release(p.id);
        return { result: {} };
      case "term/dismiss":
        pool.dismiss(p.id);
        return { result: {} };
      case "term/list":
        return { result: { terminals: pool.list(p.sessionId) } };
      case "term/keep":
        pool.setKeep(p.id, p.keep === true);
        return { result: {} };
      case "term/get_output":
        return { result: pool.output(p.id) };
      case "term/snapshot":
        return { result: pool.snapshot(p.id, p.since) };
      case "term/attach": {
        const t = pool.terms.get(p.id);
        if (!t) return { result: null };
        if (client && !client.attached.has(p.id)) {
          client.attached.add(p.id);
          t.streaming++;
        }
        return { result: pool.snapshot(p.id, p.since) };
      }
      case "term/detach": {
        const t = pool.terms.get(p.id);
        if (client?.attached.delete(p.id) && t) t.streaming = Math.max(0, t.streaming - 1);
        return { result: {} };
      }
      case "term/wait_for_exit":
        return { hold: true }; // answered on exit — see below
      case "sessions/state":
        return { result: { sessions: sessionsProvider?.() ?? [] } };
      default:
        return { error: { code: -32601, message: `unknown host method ${msg.method}` } };
    }
  }

  async function start() {
    await mkdir(dirname(sockPath), { recursive: true, mode: 0o700 });
    if (existsSync(sockPath)) await unlink(sockPath);
    server = createServer((sock) => {
      sock.setEncoding("utf8");
      const state = { buf: "" };
      sock.on("data", (d) => {
        // adopt on FIRST DATA — a silent probe must not displace the client
        if (client?.sock !== sock) {
          if (client) {
            try {
              client.sock.write(enc({ jsonrpc: "2.0", method: "_host/replaced", params: { reason: "another client connected" } }));
            } catch {}
            client.sock.destroy();
            dropClient();
          }
          client = { sock, attached: new Set() };
          sock.write(enc({ jsonrpc: "2.0", method: "_host/hello", params: {} }));
        }
        for (const line of pushLines(state, d.toString("utf8"))) {
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue; // malformed wire data must never kill the daemon
          }
          if (msg.id == null && msg.method) {
            // Unknown JSON-RPC notifications have no response.
            continue;
          }
          if (msg.method === "term/wait_for_exit") {
            const t = pool.terms.get(msg.params?.id);
            if (!t) {
              write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `unknown terminal ${msg.params?.id}` } });
              continue;
            }
            const asker = sock;
            pool.waitForExit(msg.params.id, (r) => {
              // the answer belongs to the connection that asked — a restarted
              // web's request ids restart at 1, so a late reply under the old
              // id can resolve an unrelated pending RPC. The agent re-asks
              // through the new web (the acp daemon re-holds its request).
              if (client?.sock !== asker) return;
              try {
                asker.write(enc({ jsonrpc: "2.0", id: msg.id, result: r }));
              } catch {}
            });
            continue;
          }
          let r;
          try {
            r = handle(msg);
          } catch (e) {
            r = { error: { code: -32603, message: e instanceof Error ? e.message : String(e) } };
          }
          if (r.hold) continue;
          write({ jsonrpc: "2.0", id: msg.id, ...r });
        }
      });
      sock.on("error", () => {});
      sock.on("close", () => {
        if (client?.sock === sock) dropClient();
      });
    });
    // born 0600 — no listen-then-chmod window on a 0755 state dir (N12)
    const oldUmask = process.umask(0o077);
    try {
      await new Promise((res, rej) => {
        server.once("error", rej);
        server.listen(sockPath, res);
      });
    } finally {
      process.umask(oldUmask);
    }
    await chmod(sockPath, 0o600).catch(() => {});
    startDbWatch();
    log(`host listening on ${sockPath}`);
  }

  async function stop() {
    for (const w of dbWatchers.splice(0)) {
      try {
        w.close();
      } catch {}
    }
    if (dbDebounce) clearTimeout(dbDebounce);
    try {
      server?.close();
    } catch {}
    // terminals die with the daemon process — kill them so no orphan PTYs linger
    for (const [id, t] of pool.terms) {
      try {
        t.pty?.kill();
      } catch {}
      pool.terms.delete(id);
    }
    try {
      await unlink(sockPath);
    } catch {}
  }

  return {
    start,
    stop,
    // test hooks
    _test: { pool, get client() { return client; } },
  };
}
