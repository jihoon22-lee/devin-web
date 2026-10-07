import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readTextFile } from "./fsRead.mjs";
import { LineDecoder, encodeMessage } from "./ndjson";
import { defaultConnector, type AcpConnector, type AcpTransport } from "./transport";
import type {
  InitializeResult,
  JsonRpcMessage,
  JsonRpcRequest,
  ReadTextFileRequest,
  SessionNotification,
  TerminalCreateRequest,
  TerminalRequest,
  WriteTextFileRequest,
} from "./types";
import { METHODS } from "./types";
import { terminalPool } from "./terminal";
import { fsPathAllowed, pathInRoots } from "../fsRoots";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  method: string;
  timer?: ReturnType<typeof setTimeout>;
  /** which spawned child this request was written to — a superseded child's
   *  death must only reject its own generation's requests */
  gen: number;
};

export interface ClientRequestEvent {
  /** JSON-RPC request id on the ACP wire. */
  rpcId: number | string;
  /** Opaque daemon-scoped identity, stable when a pending RPC is replayed. */
  requestId?: string;
  method: string;
  params: Record<string, unknown>;
  /** Respond back to the agent. */
  respond: (result: unknown) => void;
  respondError: (code: number, message: string) => void;
}

interface BridgeEvents {
  onSessionUpdate: (n: SessionNotification) => void;
  onNotification: (method: string, params: unknown) => void;
  /** Requests the agent makes that must be answered by a human in the browser
   *  (permission prompts, elicitation). The bridge forwards them via events. */
  onClientRequest: (ev: ClientRequestEvent) => void;
  onExit: (code: number | null, signal: string | null) => void;
  /** Resolve a sessionId to its working directory — fs requests carrying
   *  relative paths resolve against the SESSION's cwd, not this process's
   *  cwd (the web server runs from the devin-web repo, so process-relative
   *  writes from another project's session land in this tree). */
  sessionCwd?: (sessionId: string) => string | undefined;
}

const CLIENT_HANDLED = new Set<string>([
  METHODS.requestPermission,
  METHODS.elicitationCreate,
]);

export class AcpBridge {
  private proc: AcpTransport | null = null;
  private nextId = 1;
  private gen = 0;
  private pending = new Map<number | string, Pending>();
  private ready: Promise<InitializeResult> | null = null;
  private args: string[];
  private bin: string;
  private handlers: BridgeEvents;
  private initTimeoutMs: number;
  private connector: AcpConnector;
  /** real `devin acp` pid reported by the daemon in socket mode (the socket
   *  transport itself has no local child pid) */
  private remoteAcpPid: number | null = null;
  private requestIdentities = new Map<string, string>();

  constructor(
    handlers: BridgeEvents,
    args: string[] = [],
    bin = process.env.DEVIN_WEB_DEVIN_BIN || "devin",
    initTimeoutMs = 30_000,
    connector?: AcpConnector,
  ) {
    this.handlers = handlers;
    this.args = args;
    this.bin = bin;
    this.initTimeoutMs = initTimeoutMs;
    this.connector = connector ?? defaultConnector(bin, args);
  }

  /** Lazily spawn `devin acp` and initialize. Idempotent. */
  ensure(): Promise<InitializeResult> {
    if (!this.ready) {
      this.ready = this.start().catch((e) => {
        this.ready = null;
        throw e;
      });
    }
    return this.ready;
  }

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  /** PID of the `devin acp` process (for lock-owner attribution). In socket
   *  mode the daemon owns the process — the pid comes from shim_info. */
  get pid(): number | null {
    const p = this.proc?.pid;
    if (typeof p === "number" && p > 0) return p;
    return this.remoteAcpPid;
  }

  private async start(): Promise<InitializeResult> {
    const gen = ++this.gen;
    this.requestIdentities.clear();
    const proc = await this.connector();
    this.proc = proc;

    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (d) => {
      // devin logs to stderr — keep last chunk for diagnostics
      const s = d.toString();
      if (process.env.DEVIN_WEB_DEBUG) process.stderr.write(`[devin-acp] ${s}`);
      this.handlers.onNotification("_log", { message: s });
    });

    // Don't leak the acp child (and its session flocks) when the web server exits.
    const killChild = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    process.on("exit", killChild);

    // exit and spawn-error both end this child; report exactly once.
    let gone = false;
    const onGone = (code: number | null, signal: string | null, cause?: Error) => {
      if (gone) return;
      gone = true;
      process.removeListener("exit", killChild);
      const err = cause ?? new Error(`devin acp exited (code=${code} signal=${signal})`);
      // reject only this child's own requests — a superseded child must not
      // kill the replacement's in-flight work, but its own timeoutMs:0
      // prompts still need rejection or they would hang forever
      for (const [id, p] of this.pending) {
        if (p.gen !== gen) continue;
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      // a later start() replaced this child — its death must not clear the
      // new process's state or report a bogus agent_exit
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = null;
      this.handlers.onExit(code, signal);
    };
    // Without an 'error' listener a missing binary (ENOENT) throws and kills
    // the whole Next server. pid is undefined only when the spawn itself failed.
    proc.on("error", (e) => {
      const err = e as Error;
      if (proc.pid === undefined) onGone(null, null, new Error(`failed to run ${this.bin}: ${err.message}`));
      else console.error(`[devin-acp] ${err.message}`);
    });
    // EPIPE on a dead child's stdin is reported via exit/error above.
    proc.stdin?.on("error", () => {});
    proc.on("exit", (code, signal) => onGone(code as number | null, signal as string | null));

    const decoder = new LineDecoder();
    // Retain incomplete multibyte characters across transport chunks.
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (d) => {
      // Buffered frames from an exited/replaced transport belong to that
      // generation too; never capture the replacement as their requester.
      if (this.proc !== proc || this.gen !== gen) return;
      for (const line of decoder.push(d.toString("utf8"))) {
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue;
        }
        this.dispatch(msg);
      }
    });

    const result = (await this.request(METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        // advertise the revert surface — the agent only enables
        // _cognition.ai/revert/* (listSteps/forkFromStep) for clients that
        // declare the flag; the echo lives in agentCapabilities._meta
        _meta: { "cognition.ai/revert": true },
      },
      clientInfo: { name: "devin-web", version: "0.1.0" },
    }, { timeoutMs: this.initTimeoutMs }).catch((e) => {
      // init failed while the child may still be alive — kill it now so it
      // can't outlive the next start(), and detach its listeners so a later
      // exit can't reject the replacement's requests (the this.proc!==proc
      // guard in onGone is the second line of defense)
      proc.removeAllListeners();
      process.removeListener("exit", killChild);
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      if (this.proc === proc) this.proc = null;
      throw e;
    })) as InitializeResult;
    // socket mode: the daemon owns the real acp — grab its pid for lock
    // attribution (best-effort; failure just leaves pid null)
    if (proc.pid === -1) {
      void this.request<{ acpPid?: number }>("_devin-web/shim_info", {}, { timeoutMs: 5000 })
        .then((r) => {
          this.remoteAcpPid = r.acpPid ?? null;
        })
        .catch(() => {});
    }
    return result;
  }

  /** true when the transport is a daemon socket (the socket pid sentinel is
   *  -1; a spawned child has a real pid). Before connect, reflects config. */
  get socketMode(): boolean {
    return this.proc ? this.proc.pid === -1 : !!process.env.DEVIN_WEB_ACP_SOCK;
  }

  /** Sessions the daemon knows acp has loaded — lets a reconnecting web
   *  process ADOPT them without re-issuing session/load (which kills any
   *  in-flight turn). null in spawn mode or against an old daemon. */
  async daemonState(): Promise<{
    gen: number;
    acpPid?: number | null;
    sessions: { sessionId: string; cwd: string | null; loadResult: unknown; busy: boolean; remainingPrompts?: number }[];
  } | null> {
    try {
      return await this.request("_devin-web/shim_state", {}, { timeoutMs: 5000 });
    } catch {
      return null;
    }
  }

  private dispatch(msg: JsonRpcMessage) {
    // response to one of our requests — `id` with no `method` is a response
    // even when it carries neither result nor error (a bare ack): dropping
    // it leaves a timeoutMs:0 call pending forever and running stuck true
    if ("id" in msg && !("method" in msg)) {
      const p = this.pending.get(msg.id!);
      if (p) {
        this.pending.delete(msg.id!);
        if (p.timer) clearTimeout(p.timer);
        const r = msg as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
        if (r.error) {
          const e = new Error(r.error.message) as Error & { code?: number; data?: unknown };
          e.code = r.error.code;
          e.data = r.error.data;
          p.reject(e);
        } else {
          p.resolve(r.result);
        }
      }
      return;
    }
    // request from agent
    if ("id" in msg && "method" in msg) {
      this.handleAgentRequest(msg as JsonRpcRequest);
      return;
    }
    // notification
    if ("method" in msg) {
      const n = msg as { method: string; params?: unknown };
      // daemon handshake: seed our request-id space with this connection's
      // epoch so ids from a previous web generation can't collide on the wire
      if (n.method === "_devin-web/hello") {
        const connId = (n.params as { connId?: number } | undefined)?.connId;
        if (connId) this.nextId = connId * 1_000_000;
        return;
      }
      if (n.method === "_devin-web/request_identity") {
        const identity = n.params as { rpcId?: unknown; sessionId?: unknown; method?: unknown; requestId?: unknown } | undefined;
        if (identity && (typeof identity.rpcId === "number" || typeof identity.rpcId === "string") &&
            typeof identity.method === "string" && CLIENT_HANDLED.has(identity.method) &&
            typeof identity.sessionId === "string" && typeof identity.requestId === "string" &&
            /^req-[a-f0-9]{32}$/.test(identity.requestId)) {
          this.requestIdentities.set(JSON.stringify([identity.sessionId, identity.method, identity.rpcId]), identity.requestId);
        }
        return;
      }
      if (n.method === METHODS.sessionUpdate) {
        this.handlers.onSessionUpdate(n.params as SessionNotification);
      } else {
        this.handlers.onNotification(n.method, n.params);
      }
    }
  }

  private respond(id: number | string, result: unknown) {
    this.write({ jsonrpc: "2.0", id, result });
  }
  private respondError(id: number | string, code: number, message: string) {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private write(msg: JsonRpcMessage) {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(encodeMessage(msg));
    }
  }

  /** Handle agent→client requests. Permission/elicitation go to the browser;
   *  fs/terminal are served locally. */
  private handleAgentRequest(req: JsonRpcRequest) {
    const { id, method, params } = req;
    const p = (params ?? {}) as Record<string, unknown>;
    const requester = this.proc;
    const current = () => requester != null && this.proc === requester;

    if (CLIENT_HANDLED.has(method)) {
      const key = JSON.stringify([p.sessionId, method, id]);
      const requestId = this.requestIdentities.get(key);
      this.requestIdentities.delete(key);
      this.handlers.onClientRequest({
        rpcId: id,
        requestId,
        method,
        params: p,
        respond: (result) => { if (current()) this.respond(id, result); },
        respondError: (code, message) => { if (current()) this.respondError(id, code, message); },
      });
      return;
    }

    void this.serveLocally(method, p)
      .then((result) => {
        if (!current()) return;
        if (process.env.DEVIN_WEB_DEBUG) console.error(`[acp>] ${method} -> ${JSON.stringify(result)?.slice(0, 300)}`);
        this.respond(id, result);
      })
      .catch((e: Error) => {
        if (!current()) return;
        console.error(`[acp!] ${method} error: ${e.message}`);
        this.respondError(id, -32603, e.message || "internal error");
      });
  }

  private async serveLocally(method: string, p: Record<string, unknown>): Promise<unknown> {
    if (process.env.DEVIN_WEB_DEBUG) console.error(`[acp<] ${method} ${JSON.stringify(p).slice(0, 400)}`);
    switch (method) {
      case METHODS.fsRead: {
        const r = p as unknown as ReadTextFileRequest;
        const base = this.handlers.sessionCwd?.(r.sessionId) ?? process.cwd();
        const path = resolve(base, r.path);
        if (!fsPathAllowed(path) && !pathInRoots(path, [base]))
          throw new Error(`path outside DEVIN_WEB_FS_ROOTS: ${r.path}`);
        return { content: await readTextFile(path, r.line, r.limit) };
      }
      case METHODS.fsWrite: {
        const r = p as unknown as WriteTextFileRequest;
        const wbase = this.handlers.sessionCwd?.(r.sessionId) ?? process.cwd();
        const wpath = resolve(wbase, r.path);
        if (!fsPathAllowed(wpath) && !pathInRoots(wpath, [wbase]))
          throw new Error(`path outside DEVIN_WEB_FS_ROOTS: ${r.path}`);
        await writeFile(wpath, r.content, "utf8");
        return {};
      }
      case METHODS.terminalCreate: {
        const r = p as unknown as TerminalCreateRequest;
        const res = await terminalPool.create(r, () => {});
        // One lightweight discovery event per terminal; output chunks flow
        // only through terminalPool listeners (no per-chunk bus traffic).
        this.handlers.onNotification("_devin-web/terminal_created", {
          sessionId: r.sessionId,
          terminalId: res.terminalId,
        });
        return res;
      }
      case METHODS.terminalOutput: {
        const r = p as unknown as TerminalRequest;
        return terminalPool.output(r.terminalId);
      }
      case METHODS.terminalWaitForExit: {
        const r = p as unknown as TerminalRequest;
        return terminalPool.waitForExit(r.terminalId);
      }
      case METHODS.terminalKill: {
        const r = p as unknown as TerminalRequest;
        await terminalPool.kill(r.terminalId);
        return {};
      }
      case METHODS.terminalRelease: {
        const r = p as unknown as TerminalRequest;
        await terminalPool.release(r.terminalId);
        return {};
      }
      default:
        throw new Error(`unsupported client method: ${method}`);
    }
  }

  /** Default ceiling for short control requests. session/prompt (and anything
   *  long-lived) must pass timeoutMs:0 — a turn can legitimately run for hours. */
  request<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    const id = this.nextId++;
    // A dead/closing child can't receive the request — reject now instead of
    // leaving the promise to hang until the timeout (or forever, pre-3-7).
    if (!this.proc?.stdin?.writable) {
      return Promise.reject(new Error(`devin acp is not running (cannot send ${method})`));
    }
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    return new Promise<T>((resolve2, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      timer?.unref?.();
      this.pending.set(id, { resolve: resolve2 as (v: unknown) => void, reject, method, timer, gen: this.gen });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  kill() {
    const proc = this.proc;
    this.proc = null;
    this.ready = null; // a stale ready promise would hand out the dead gen
    proc?.kill();
    // the detached child's exit handler early-returns (proc !== this.proc),
    // so its in-flight requests would hang — reject them here
    const err = new Error("bridge killed");
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
