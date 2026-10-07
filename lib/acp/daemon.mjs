// devin-acpd — keeps `devin acp` alive independently of the web server.
//
// The web server connects over a unix socket instead of spawning the agent;
// while the socket has no client, this daemon:
//   - holds agent→client requests for a grace window, then answers them with
//     the protocol-defined cancel (permission/elicitation) or a JSON-RPC
//     error — a failed tool call lets the turn continue;
//   - ring-buffers notifications per session for replay on reconnect
//     (deep history comes from sessions.db via the transcript REST API);
//   - tracks which sessions acp has loaded so a new client can ADOPT them
//     without re-issuing session/load (re-load kills in-flight turns).
//
// Passthrough is line-verbatim: original NDJSON lines are forwarded as-is;
// only a decoded copy is parsed for interception. Intercepted lines are
// answered locally and never forwarded.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { writeFile, rename, unlink, chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readTextFile } from "./fsRead.mjs";
import { dirname, resolve, sep } from "node:path";

// ---------- tiny NDJSON helpers (mirror lib/acp/ndjson.ts) ----------
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

// ---------- fs allowlist (mirror lib/fsRoots.ts — keep in sync) ----------
function pathInRoots(path, rootList) {
  if (!rootList.length) return true;
  const p = resolve(path);
  return rootList.some((r) => p === r || p.startsWith(r + sep));
}

const CLIENT_REQUESTS = new Set([
  "session/request_permission",
  "fs/read_text_file",
  "fs/write_text_file",
  "terminal/create",
  "terminal/output",
  "terminal/wait_for_exit",
  "terminal/kill",
  "terminal/release",
  "elicitation/create",
  "elicitation/complete",
]);

const FS_METHODS = new Set(["fs/read_text_file", "fs/write_text_file"]);

const RESPAWN_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const CIRCUIT_BREAKER = { earlyExitMs: 5000, maxEarlyExits: 5 };

/**
 * @param {object} opts
 * @param {string} opts.sockPath
 * @param {string} [opts.bin]
 * @param {string[]} [opts.args]
 * @param {string[]|null} [opts.cmd] - test override: full argv instead of
 *   [bin, "acp", ...args]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string[]} [opts.fsRoots]
 * @param {number} [opts.requestGraceMs]
 * @param {number[]} [opts.respawnBackoffMs]
 * @param {number} [opts.sessionBufferBytes]
 * @param {number} [opts.globalBufferBytes]
 * @param {(e: object) => void} [opts.onEvent]
 */
export function createDaemon({
  sockPath,
  bin = "devin",
  args = [],
  cmd = null, // test override: full argv instead of [bin, "acp", ...args]
  env = process.env,
  fsRoots = [],
  requestGraceMs = 60_000,
  respawnBackoffMs = RESPAWN_BACKOFF_MS,
  sessionBufferBytes = 2 * 1024 * 1024,
  globalBufferBytes = 16 * 1024 * 1024,
  onEvent = () => {},
}) {
  const roots = fsRoots.map((r) => resolve(r));
  const t0 = Date.now();
  let acp = null; // { proc, gen, spawnedAt }
  let gen = 0;
  let cachedInit = null;
  let degraded = null; // circuit-breaker reason
  let consecutiveEarlyExits = 0;
  let respawnTimer = null;
  let server = null;
  let stopped = false;

  // client state
  let client = null; // { sock, initialized, addr, connId }
  // EVERY accepted connection — adopted or silent probe. server.close()
  // waits for all of them, so stop() must destroy the whole set, not just
  // the adopted client (a mute scanner socket would hang shutdown forever).
  const conns = new Set();
  let connSeq = 0; // per-daemon connection epoch — clients seed their request
  // id space from it so ids from a dead web generation can never collide
  // with (or be misattributed to) a live one's in-flight requests
  let clientState = { buf: "" };
  const agentState = { buf: "" };

  // operational status the web can read WITHOUT touching the socket — a
  // probe connection would be adopted on first data and displace the live
  // bridge, so health/badge consumers read this file instead
  const statusPath = resolve(dirname(sockPath), "acpd-status.json");
  // Serialized + atomic: concurrent writeFile calls finished out of order, so
  // a drop's `connectedClient:null` could outlive the adopt that superseded
  // it — idle-restart's daemonHasClient() would then let a speaking shimBusy
  // probe displace the live bridge. Snapshot at call time, chain the writes,
  // publish via rename so a crash can't leave a truncated file either.
  let statusChain = Promise.resolve();
  function writeStatus() {
    const body = JSON.stringify({
      pid: process.pid,
      acpPid: acp?.proc?.pid ?? null,
      gen,
      degraded,
      connectedClient: client ? client.addr : null,
      loadedSessions: loadedSessions.size,
      updatedAt: new Date().toISOString(),
    }) + "\n";
    const tmp = `${statusPath}.tmp-${process.pid}`;
    statusChain = statusChain.then(async () => {
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, statusPath);
    }).catch(() => {});
  }

  // loaded sessions: sessionId -> { sessionId, cwd, result }
  const loadedSessions = new Map();
  // busy tracking: sessionId -> # of outstanding session/prompt requests.
  // A prompt response ends the turn — that's how a reconnecting client learns
  // "this session is mid-turn, adopt it, do NOT re-issue session/load".
  const busySessions = new Map();
  // shim-synthesized notification lines queued by trackAgentLine, flushed by
  // the stdout loop right after the triggering line
  const pendingExtra = [];
  // client->agent request ids whose responses we care about
  const watchIds = new Map(); // id -> "new" | "load" | "init" | "delete" | "prompt"
  // undelivered agent->client lines (requests + notifications), in order
  let undelivered = []; // { line, kind: "request"|"notif", sessionId, reqId, method, at, bytes }
  let undeliveredBytes = 0;
  const perSessionBytes = new Map(); // sessionId -> bytes (notifications only)
  let resyncNeeded = false;
  // agent->client requests answered-by-shim grace timers
  const heldReqs = new Map(); // reqId -> { timer, sessionId, method }
  // agent->client requests forwarded to a live client, awaiting its answer
  const requestIdentities = new Map(); // active agent RPC id -> opaque card identity
  const inFlightAgentReqs = new Map(); // reqId -> { line, sessionId, method }

  const log = (m) => onEvent({ type: "log", message: m });

  // ---------------- acp child ----------------

  function spawnAcp() {
    if (stopped || degraded) return;
    agentState.buf = ""; // never carry a partial line into a new agent
    const g = ++gen;
    const argv = cmd ?? [bin, "acp", ...args];
    const proc = spawn(argv[0], argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...env },
      // neutral cwd — the daemon (and everything it spawns) inherits the
      // ctl caller's cwd, usually the devin-web repo. Any acp-internal tool
      // resolving relative paths against process.cwd() would then drop
      // artifacts into that repo (the b9-*.png pollution). The state dir
      // is a writable, out-of-tree landing zone instead.
      cwd: dirname(sockPath),
    });
    acp = { proc, gen: g, spawnedAt: Date.now() };
    writeStatus();
    // keep WARN/ERROR and unlevelled lines (panics); the INFO/DEBUG/TRACE
    // tracing spans are pure noise — ~6MB/day before this filter
    const errState = { buf: "" };
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.on("data", (d) => {
      for (const line of pushLines(errState, d.toString("utf8"))) {
        if (/\b(?:INFO|DEBUG|TRACE)\b/.test(line)) continue;
        log(`[acp] ${line}`);
      }
    });
    proc.stdin?.on("error", () => {});
    proc.on("error", (e) => {
      if (proc.pid === undefined) onAcpGone(g, null, null, e);
      else log(`acp error: ${e.message}`);
    });
    proc.on("exit", (code, signal) => onAcpGone(g, code, signal));
    proc.stdout?.on("data", (d) => {
      // parse a copy for tracking; forward original lines to the client
      for (const line of pushLines(agentState, d.toString("utf8"))) {
        // a tracking bug must never kill the daemon — the acp child would be
        // orphaned holding session locks while the web falls back to spawning
        // a second agent. Log and keep forwarding the line verbatim.
        let tracked = { init: false, msg: null };
        try {
          tracked = trackAgentLine(line);
        } catch (e) {
          log(`track error (line ignored for tracking): ${e.message}`);
        }
        // deliver reuses the already-parsed msg — one JSON.parse per line,
        // not two (track + deliver used to each parse the same text)
        if (!tracked.served) deliver(line, tracked.msg);
        // synthesized shim notifications (e.g. turn_end for adopted sessions)
        // go right after the line that produced them
        for (const e of pendingExtra.splice(0)) deliver(e);
        // the real (non-cached) initialize handshake completes here — the
        // response goes first, then anything buffered while unconnected
        if (tracked.init && client) {
          client.initialized = true;
          flushUndelivered();
        }
      }
    });
  }

  function onAcpGone(g, code, signal, cause) {
    if (!acp || acp.gen !== g) return;
    const early = Date.now() - acp.spawnedAt < CIRCUIT_BREAKER.earlyExitMs;
    consecutiveEarlyExits = early ? consecutiveEarlyExits + 1 : 0;
    acp = null;
    cachedInit = null;
    loadedSessions.clear();
    busySessions.clear();
    watchIds.clear();
    watchedSessionIds.clear();
    watchedCwds.clear();
    // undelivered items die with the agent — their requests need no reply
    // (nobody is listening); notifications are worthless without their turn.
    for (const h of heldReqs.values()) clearTimeout(h.timer);
    heldReqs.clear();
    inFlightAgentReqs.clear();
    requestIdentities.clear();
    writeStatus();
    undelivered = [];
    undeliveredBytes = 0;
    perSessionBytes.clear();
    log(`acp exited (code=${code} signal=${signal}${cause ? " " + cause.message : ""}) gen=${g}`);

    // the client must re-handshake against the next process generation
    if (client) {
      try {
        client.sock.destroy();
      } catch {}
      dropClient();
    }

    if (stopped) { writeStatus(); return; }
    if (consecutiveEarlyExits >= CIRCUIT_BREAKER.maxEarlyExits) {
      degraded = `acp exited ${consecutiveEarlyExits}x within ${CIRCUIT_BREAKER.earlyExitMs}ms — not respawning (auth/config broken?)`;
      log(`circuit breaker: ${degraded}`);
      writeStatus();
      return;
    }
    const wait = respawnBackoffMs[Math.min(consecutiveEarlyExits, respawnBackoffMs.length - 1)];
    respawnTimer = setTimeout(spawnAcp, wait);
    respawnTimer.unref?.();
    writeStatus();
  }

  // ---------------- agent -> client tracking + delivery ----------------

  /** Returns true when the line was the initialize response (caller flushes
   *  buffered items right after delivering it). */
  function trackAgentLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return { init: false, msg: null };
    }
    // responses to our watched client->agent requests
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const kind = watchIds.get(msg.id);
      if (kind) {
        watchIds.delete(msg.id);
        const sid = watchedSessionIds.get(msg.id);
        const cwd = watchedCwds.get(msg.id);
        watchedSessionIds.delete(msg.id);
        watchedCwds.delete(msg.id);
        if (msg.result !== undefined) {
          if (kind === "init") {
            cachedInit = msg.result;
            return { init: true, msg };
          }
          if (kind === "new" || kind === "load") {
            // {"id":N,"result":null} is legal JSON-RPC — never dereference it
            const sessionId = kind === "new" ? (msg.result?.sessionId ?? null) : sid;
            if (sessionId) loadedSessions.set(sessionId, { sessionId, cwd: cwd ?? null, result: msg.result });
          }
          if (kind === "delete" && sid) loadedSessions.delete(sid);
        }
        // a prompt ends the turn on error responses too — an error inside the
        // result-only gate left busy stuck forever (and wedged --when-idle's
        // restart checks downstream)
        if (kind === "prompt" && sid) {
          busySessions.set(sid, Math.max(0, (busySessions.get(sid) ?? 0) - 1));
          // a web process that restarted mid-turn never sees the prompt
          // response resolve — this synthesized notification lets the new
          // manager clear its adopted running state (idempotent otherwise)
          pendingExtra.push(enc({ jsonrpc: "2.0", method: "_devin-web/turn_end", params: { sessionId: sid } }));
        }
      }
      return { init: false, msg };
    }
    // agent->client request: hold if no ready client
    if (msg.id != null && msg.method && CLIENT_REQUESTS.has(msg.method)) {
      const sessionId = msg.params?.sessionId ?? null;
      // Only a newly received agent request allocates identity. Replaying the
      // held wire line keeps it; a later legal reuse of this RPC id gets a new one.
      if (!FS_METHODS.has(msg.method)) requestIdentities.set(msg.id, `req-${randomBytes(16).toString("hex")}`);
      if (!clientReady()) {
        // fs needs no human — answer it here so agent file IO survives a web
        // restart (round 4 design, R12 C3). Holding it stalled the tool call
        // for the whole outage and errored after the grace window.
        if (FS_METHODS.has(msg.method)) {
          const asker = acp;
          void serveFs(msg, (r) => {
            // File IO can finish after the requesting agent has exited.
            // Its recycled request id must never reach a new process.
            if (!asker || acp !== asker) return;
            writeAgent(enc({ jsonrpc: "2.0", id: msg.id, ...r }));
          });
          return { init: false, msg, served: true };
        }
        holdRequest(msg.id, line, msg.method, sessionId);
      } else {
        inFlightAgentReqs.set(msg.id, { line, sessionId, method: msg.method });
      }
      return { init: false, msg };
    }
    // turn-end notification — belt & suspenders for busy tracking in case a
    // prompt response was lost or the agent finished some other way
    if (msg.method === "_cognition.ai/agent_stopped" && msg.params?.sessionId) {
      busySessions.set(msg.params.sessionId, 0);
    }
    return { init: false, msg };
  }

  const watchedSessionIds = new Map();
  const watchedCwds = new Map();

  function clientReady() {
    return !!client && client.initialized;
  }

  function sendRequestIdentity(rpcId, sessionId, method) {
    const requestId = requestIdentities.get(rpcId);
    if (requestId) writeClient(enc({ jsonrpc: "2.0", method: "_devin-web/request_identity",
      params: { rpcId, sessionId, method, requestId } }));
  }

  function deliver(line, msg) {
    if (msg === undefined) {
      try {
        msg = JSON.parse(line);
      } catch {
        msg = null;
      }
    }
    const isReq = msg && msg.id != null && msg.method && CLIENT_REQUESTS.has(msg.method);
    if (clientReady()) {
      if (isReq) sendRequestIdentity(msg.id, msg.params?.sessionId ?? null, msg.method);
      writeClient(line + "\n");
      return;
    }
    if (isReq) return; // already handled by holdRequest in trackAgentLine
    // notification (or unparseable line): buffer for replay
    const sessionId = msg?.params?.sessionId ?? "";
    const bytes = Buffer.byteLength(line) + 1;
    undelivered.push({ line, kind: "notif", sessionId, at: Date.now(), bytes });
    undeliveredBytes += bytes;
    perSessionBytes.set(sessionId, (perSessionBytes.get(sessionId) ?? 0) + bytes);
    evict(sessionId);
  }

  function evict(sessionId) {
    // per-session cap drops that session's oldest notif; the global cap drops
    // the global oldest. A busy session must never evict another session's
    // replay data (a quiet session would see a phantom resync gap)
    const over = (m, cap) => m > cap;
    const dropOldest = (sid) => {
      const idx = undelivered.findIndex(
        (u) => u.kind === "notif" && (sid === undefined || u.sessionId === sid),
      );
      if (idx < 0) return false; // only requests left — cap-exempt (grace handles them)
      const [u] = undelivered.splice(idx, 1);
      undeliveredBytes -= u.bytes;
      perSessionBytes.set(u.sessionId, (perSessionBytes.get(u.sessionId) ?? 0) - u.bytes);
      resyncNeeded = true;
      return true;
    };
    while (over(perSessionBytes.get(sessionId) ?? 0, sessionBufferBytes) && dropOldest(sessionId)) {}
    while (over(undeliveredBytes, globalBufferBytes) && dropOldest(undefined)) {}
  }

  function holdRequest(reqId, line, method, sessionId) {
    const bytes = Buffer.byteLength(line) + 1;
    undelivered.push({ line, kind: "request", sessionId, reqId, method, at: Date.now(), bytes });
    undeliveredBytes += bytes;
    const timer = setTimeout(() => {
      // grace expired — answer with the protocol-defined cancellation so the
      // agent records a user cancel, not a tool failure (except fs/terminal,
      // which have no cancel semantic → JSON-RPC error)
      let result;
      if (method === "session/request_permission") result = { outcome: { outcome: "cancelled" } };
      else if (method?.startsWith("elicitation/")) result = { action: "cancel" };
      writeAgent(enc(result !== undefined
        ? { jsonrpc: "2.0", id: reqId, result }
        : { jsonrpc: "2.0", id: reqId, error: { code: -32603, message: "client disconnected" } }));
      heldReqs.delete(reqId);
      requestIdentities.delete(reqId);
      undelivered = undelivered.filter((u) => {
        if (u.reqId !== reqId) return true;
        undeliveredBytes -= u.bytes; // without this the global cap shrinks forever
        return false;
      });
    }, requestGraceMs);
    timer.unref?.();
    heldReqs.set(reqId, { timer, sessionId, method });
  }

  // ---------------- client handling ----------------

  function onClientData(d, sock) {
    for (const line of pushLines(clientState, d.toString("utf8"))) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        writeAgent(line + "\n");
        continue;
      }
      try {
        if (msg.id != null && msg.method) {
          if (interceptClientRequest(msg, sock)) continue;
          // watch responses for session tracking
          if (msg.method === "initialize") watchIds.set(msg.id, "init");
          else if (msg.method === "session/new" || msg.method === "session/fork") {
            // A fork returns a NEW loaded session id too. Track the child,
            // not params.sessionId (the parent), so busy adoption survives
            // web restarts and idle checks include the child's live turn.
            watchIds.set(msg.id, "new");
            // same as session/load: the adopt path reports this cwd to the web
            // process — without it, adopted sessions fall back to the web's own
            // process cwd and Changes/re-load target the wrong repository
            watchedCwds.set(msg.id, msg.params?.cwd);
          } else if (msg.method === "session/load") {
            watchIds.set(msg.id, "load");
            watchedSessionIds.set(msg.id, msg.params?.sessionId);
            watchedCwds.set(msg.id, msg.params?.cwd);
          } else if (msg.method === "session/delete") {
            watchIds.set(msg.id, "delete");
            watchedSessionIds.set(msg.id, msg.params?.sessionId);
          } else if (msg.method === "session/prompt") {
            watchIds.set(msg.id, "prompt");
            watchedSessionIds.set(msg.id, msg.params?.sessionId);
            const sid = msg.params?.sessionId;
            if (sid) busySessions.set(sid, (busySessions.get(sid) ?? 0) + 1);
          }
          writeAgent(line + "\n");
        } else {
          // response to an agent->client request (answered), or a notification
          if (msg.id != null) {
            inFlightAgentReqs.delete(msg.id);
            requestIdentities.delete(msg.id);
          }
          writeAgent(line + "\n");
        }
      } catch (e) {
        // a bad client line must not kill the daemon — log and move on
        log(`client line error: ${e.message}`);
      }
    }
  }

  function interceptClientRequest(msg, sock) {
    if (msg.method === "initialize" && cachedInit) {
      sock.write(enc({ jsonrpc: "2.0", id: msg.id, result: cachedInit }));
      onClientInitialized(sock);
      return true;
    }
    if (msg.method === "_devin-web/shim_info") {
      sock.write(enc({ jsonrpc: "2.0", id: msg.id, result: shimInfo() }));
      return true;
    }
    if (msg.method === "_devin-web/shim_state") {
      sock.write(enc({
        jsonrpc: "2.0", id: msg.id,
        result: {
          gen,
          acpPid: acp?.proc.pid ?? null,
          sessions: [...loadedSessions.values()].map((s) => ({
            sessionId: s.sessionId,
            cwd: s.cwd,
            loadResult: s.result,
            busy: (busySessions.get(s.sessionId) ?? 0) > 0,
          })),
        },
      }));
      return true;
    }
    return false;
  }

  async function serveFs(msg, respond) {
    try {
      // relative paths resolve against the SESSION's cwd (tracked by the
      // client watch path), not the daemon's own cwd — otherwise another
      // project's relative fs writes land in whatever directory spawned
      // the daemon.
      const base = loadedSessions.get(msg.params?.sessionId)?.cwd ?? process.cwd();
      const path = resolve(base, String(msg.params?.path ?? ""));
      if (!pathInRoots(path, roots) && !pathInRoots(path, [base])) {
        respond({ error: { code: -32603, message: `path outside DEVIN_WEB_FS_ROOTS: ${msg.params?.path}` } });
        return;
      }
      if (msg.method === "fs/read_text_file") {
        const { line, limit } = msg.params ?? {};
        respond({ result: { content: await readTextFile(path, line, limit) } });
      } else {
        await writeFile(path, String(msg.params?.content ?? ""), "utf8");
        respond({ result: {} });
      }
    } catch (e) {
      respond({ error: { code: -32603, message: e.message } });
    }
  }

  function onClientInitialized(sock) {
    if (client?.sock === sock) {
      client.initialized = true;
      flushUndelivered();
    }
  }

  function flushUndelivered() {
    if (!clientReady()) return;
    if (resyncNeeded) {
      resyncNeeded = false;
      writeClient(enc({ jsonrpc: "2.0", method: "_devin-web/resync_needed", params: {} }));
    }
    const items = undelivered;
    undelivered = [];
    undeliveredBytes = 0;
    perSessionBytes.clear();
    const flushedSessions = new Set();
    for (const u of items) {
      if (u.kind === "request") {
        const h = heldReqs.get(u.reqId);
        if (!h) continue; // expired already
        clearTimeout(h.timer);
        heldReqs.delete(u.reqId);
        inFlightAgentReqs.set(u.reqId, { line: u.line, sessionId: u.sessionId, method: u.method });
        sendRequestIdentity(u.reqId, u.sessionId, u.method);
      }
      if (u.sessionId) flushedSessions.add(u.sessionId);
      writeClient(u.line + "\n");
    }
    // end-of-replay marker: the web re-seeds those sessions so content that
    // double-rendered behind a mid-replay guard reset converges back. It must
    // be written strictly after the replayed lines on the same socket.
    if (flushedSessions.size) {
      writeClient(enc({ jsonrpc: "2.0", method: "_devin-web/flushed", params: { sessions: [...flushedSessions] } }));
    }
  }

  function writeClient(data) {
    if (!client) return;
    const sock = client.sock;
    const ok = sock.write(data);
    if (!ok) {
      acp?.proc.stdout?.pause();
      // resume only if this socket is still the live client — a dead socket's
      // drain never fires, so dropClient() must un-pause instead. One listener
      // per socket — every backed-up write used to add another (MaxListeners
      // warning + listener pileup on slow clients)
      if (!sock._dwDrain) {
        sock._dwDrain = true;
        sock.once("drain", () => {
          sock._dwDrain = false;
          if (client?.sock === sock) acp?.proc.stdout?.resume();
        });
      }
    }
  }

  function writeAgent(data) {
    if (!acp) return;
    const stdin = acp.proc.stdin;
    const ok = stdin.write(data);
    if (!ok && client) {
      client.sock.pause();
      if (!stdin._dwDrain) {
        stdin._dwDrain = true;
        stdin.once("drain", () => {
          stdin._dwDrain = false;
          client?.sock.resume();
        });
      }
    }
  }

  function dropClient() {
    client = null;
    clientState = { buf: "" };
    // a drain listener on the dead socket will never fire — if output was
    // paused for its backpressure, the agent stays blocked forever
    acp?.proc.stdout?.resume();
    // requests the dead client never answered go back to the held queue with
    // a fresh grace window — the agent still awaits a reply
    for (const [reqId, r] of inFlightAgentReqs) {
      holdRequest(reqId, r.line, r.method, r.sessionId);
    }
    inFlightAgentReqs.clear();
    writeStatus();
  }

  function shimInfo() {
    return {
      acpPid: acp?.proc.pid ?? null,
      acpAlive: !!acp,
      gen,
      uptime: Math.floor((Date.now() - t0) / 1000),
      degraded,
      connectedClient: client ? client.addr : null,
      connId: client?.connId ?? null,
      loadedSessions: loadedSessions.size,
    };
  }

  // ---------------- lifecycle ----------------

  async function start() {
    // the socket must be born 0600 — listen() before chmod() left a window
    // where the state dir (0755) exposed a world-accessible socket (N12)
    await mkdir(dirname(sockPath), { recursive: true, mode: 0o700 });
    if (existsSync(sockPath)) await unlink(sockPath);
    spawnAcp();
    server = createServer((sock) => {
      sock.setEncoding("utf8");
      conns.add(sock);
      const addr = `${sock.remoteAddress ?? "local"}:${Date.now()}`;
      // adopt on FIRST DATA, not on bare connect — a probe or port scanner
      // that never speaks must not displace the live client
      sock.on("data", (d) => {
        if (client?.sock !== sock) {
          if (client) {
            try {
              client.sock.write(enc({ jsonrpc: "2.0", method: "_devin-web/replaced", params: { reason: "another client connected" } }));
            } catch {}
            client.sock.destroy();
            dropClient();
          }
          client = { sock, initialized: false, addr, connId: ++connSeq };
          clientState = { buf: "" };
          writeStatus();
          // first line on the wire: tells the client its id-space epoch
          sock.write(enc({ jsonrpc: "2.0", method: "_devin-web/hello", params: { connId: client.connId } }));
        }
        onClientData(d, sock);
      });
      sock.on("error", () => {});
      sock.on("close", () => {
        conns.delete(sock);
        if (client?.sock === sock) dropClient();
      });
      // an agent->client request may arrive before this client initializes —
      // it sits in `undelivered` until initialize completes (or grace ends)
    });
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
  }

  async function stop() {
    stopped = true;
    if (respawnTimer) clearTimeout(respawnTimer);
    if (client) {
      try {
        client.sock.destroy();
      } catch {}
    }
    if (acp) {
      const proc = acp.proc;
      try {
        proc.kill("SIGTERM");
      } catch {}
      // escalate if the agent ignores SIGTERM — shutdown must not hang on it
      await new Promise((r) => {
        const t = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
          r();
        }, 5000);
        t.unref?.();
        proc.once?.("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    }
    if (server) {
      // adopted client above + every silent probe still holding a socket —
      // close() alone waits on open connections indefinitely
      for (const s of conns) {
        try {
          s.destroy();
        } catch {}
      }
      await new Promise((r) => server.close(r));
    }
    if (existsSync(sockPath)) await unlink(sockPath).catch(() => {});
    // drain queued status writes — callers may remove the state dir right
    // after stop() resolves, and a late write would race that teardown
    await statusChain;
  }

  // session state snapshot for the host channel (ev/hello, sessions/state) —
  // same data shim_state serves on the acp socket
  function sessionsState() {
    return [...loadedSessions.values()].map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      busy: (busySessions.get(s.sessionId) ?? 0) > 0,
      loaded: true,
    }));
  }

  return { start, stop, info: shimInfo, sessionsState, get loadedSessions() { return loadedSessions; }, _test: { get acp() { return acp; }, get client() { return client; }, get undelivered() { return undelivered; }, get undeliveredBytes() { return undeliveredBytes; }, spawnAcp, onAcpGone } };
}
