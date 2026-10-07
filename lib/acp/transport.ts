import { spawn } from "node:child_process";
import { connect, Socket } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Minimal ChildProcess-shaped surface the AcpBridge needs — a spawned
 *  `devin acp` satisfies it natively, and a unix-socket connection to
 *  devin-acpd is adapted to it so the bridge stays transport-agnostic. */
export interface AcpTransport {
  /** undefined = the spawn/connect itself failed (bridge treats like ENOENT);
   *  for sockets this is a sentinel — the real agent pid comes via shim_info. */
  readonly pid: number | undefined;
  /** null while running; 0 once ended — mirrors ChildProcess.exitCode. */
  readonly exitCode: number | null;
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "error" | "exit", cb: (...args: unknown[]) => void): void;
  removeAllListeners(): void;
  kill(signal?: string): void;
}

export type AcpConnector = () => Promise<AcpTransport>;

export function spawnConnector(bin: string, args: string[]): AcpConnector {
  return () => Promise.resolve(spawn(bin, ["acp", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  }) as unknown as AcpTransport);
}

/** Duck-type a unix-socket connection as a ChildProcess: stdin/stdout are the
 *  socket itself (duplex — pause/resume give us real backpressure), 'close'
 *  maps to 'exit', and a refused/failed connect looks like a spawn failure. */
class SocketTransport implements AcpTransport {
  private sock: Socket;
  private connected = false;
  private closed = false;
  private cbs: { error: ((...a: unknown[]) => void)[]; exit: ((...a: unknown[]) => void)[] } = { error: [], exit: [] };

  constructor(sockPath: string, ready: (t: SocketTransport | null, e?: Error) => void) {
    this.sock = connect(sockPath);
    const onErr = (e: Error) => {
      this.closed = true;
      if (!this.connected) {
        ready(null, e);
      }
      for (const cb of this.cbs.error) cb(e);
    };
    this.sock.once("connect", () => {
      this.connected = true;
      ready(this);
    });
    this.sock.on("error", onErr);
    this.sock.on("close", () => {
      this.closed = true;
      for (const cb of this.cbs.exit) cb(null, null);
    });
  }

  get pid() {
    // pre-connect: undefined so a refused connect is treated as spawn failure
    return this.connected ? -1 : undefined;
  }
  get exitCode() {
    return this.closed ? 0 : null;
  }
  get stdin() {
    return this.sock;
  }
  get stdout() {
    return this.sock;
  }
  get stderr() {
    return null;
  }
  on(event: "error" | "exit", cb: (...args: unknown[]) => void) {
    this.cbs[event].push(cb);
  }
  removeAllListeners() {
    // Only clear the bridge's callback arrays — stripping the socket's own
    // listeners would leave a later 'error' event unhandled (process crash)
    // and stop `closed`/`exitCode` from ever updating.
    this.cbs = { error: [], exit: [] };
  }
  kill() {
    this.sock.destroy();
  }
}

export function socketConnector(sockPath: string): AcpConnector {
  return () =>
    new Promise<AcpTransport>((res, rej) => {
      new SocketTransport(sockPath, (t, e) => (t ? res(t) : rej(e)));
    });
}

/** Cheap liveness probe — is the daemon process alive? Checks the pidfile
 *  next to the socket rather than connecting: a bare connect has side
 *  effects (older daemons displace the live client on ANY connection).
 *  Used by /api/health so a passive status poll never triggers the spawn
 *  fallback (a second agent competing for the same session locks). */
export function daemonPidAlive(sockPath = process.env.DEVIN_WEB_ACP_SOCK): boolean | null {
  if (!sockPath) return null;
  try {
    const pidfile = join(dirname(sockPath), "acpd.pid");
    const pid = Number(readFileSync(pidfile, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // no pidfile, or stale — treat as down
  }
}

export interface DaemonStatus {
  pid?: number;
  acpPid?: number | null;
  gen?: number;
  degraded?: string | null;
  connectedClient?: string | null;
  loadedSessions?: number;
  updatedAt?: string;
}

/** Passive daemon status — the daemon writes acpd-status.json next to its
 *  socket on every state change. Reading the file is the ONLY safe probe:
 *  a socket connect gets adopted on first data and displaces the bridge. */
export function daemonStatus(sockPath = process.env.DEVIN_WEB_ACP_SOCK): DaemonStatus | null {
  if (!sockPath) return null;
  try {
    return JSON.parse(readFileSync(join(dirname(sockPath), "acpd-status.json"), "utf8")) as DaemonStatus;
  } catch {
    return null;
  }
}

/** Socket only by default — a dead daemon must NOT silently spawn a second
 *  agent (it would compete for the same session locks while the orphaned acp
 *  may still be alive). DEVIN_WEB_ACP_FALLBACK=1 re-enables the old
 *  spawn-fallback for dev setups without a daemon. */
export function defaultConnector(
  bin: string,
  args: string[],
  sockPath = process.env.DEVIN_WEB_ACP_SOCK,
  fallbackToSpawn = process.env.DEVIN_WEB_ACP_FALLBACK === "1",
): AcpConnector {
  if (!sockPath) return spawnConnector(bin, args);
  const viaSocket = socketConnector(sockPath);
  const viaSpawn = spawnConnector(bin, args);
  return async () => {
    try {
      return await viaSocket();
    } catch (e) {
      if (!fallbackToSpawn) throw e;
      console.error(`[acp] daemon socket unavailable (${(e as Error).message}) — falling back to spawn`);
      return viaSpawn();
    }
  };
}
