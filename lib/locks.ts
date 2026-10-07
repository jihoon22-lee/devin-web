import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEVIN_CLI_DIR =
  process.env.DEVIN_CLI_DIR || join(homedir(), ".local/share/devin/cli");

export interface LockOwner {
  pid: number;
  cmdline: string;
  alive: boolean;
  ours: boolean;
  /** holder's argv0 is a devin binary — only then may takeover signal it */
  isDevin: boolean;
  /** devin version parsed from the holder's cmdline (_versions/<ver>/bin/devin). */
  version?: string | null;
}

/** A session is locked by a live foreign devin process — callers that would
 *  destroy or overwrite its state must refuse until a takeover moves the
 *  lock to us. Routes map this to 409. */
export class LockedSessionError extends Error {
  readonly owner: LockOwner;
  constructor(sessionId: string, owner: LockOwner) {
    super(
      `session ${sessionId} is open in another devin process (pid ${owner.pid}) — take it over first`,
    );
    this.owner = owner;
  }
}

/** argv0 is `devin` or `…/devin` (e.g. _versions/<ver>/bin/devin). */
export function isDevinCmdline(cmdline: string): boolean {
  const argv0 = cmdline.trim().split(/\s+/)[0] ?? "";
  return argv0 === "devin" || argv0.endsWith("/devin");
}

/** Read session_locks/<id>.lock → PID, then resolve the holder's cmdline. */
export function lockOwner(sessionId: string, ourPid: number | null): LockOwner | null {
  const f = join(DEVIN_CLI_DIR, "session_locks", `${sessionId}.lock`);
  try {
    if (!existsSync(f)) return null;
    const pid = parseInt(readFileSync(f, "utf8").trim(), 10);
    if (!Number.isFinite(pid)) return null;
    let cmdline = "";
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch {
      /* process gone or unreadable */
    }
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      /* dead */
    }
    return {
      pid,
      cmdline,
      alive,
      ours: pid === ourPid,
      isDevin: isDevinCmdline(cmdline),
      version: /_versions\/([^/]+)\//.exec(cmdline)?.[1] ?? null,
    };
  } catch {
    return null;
  }
}

/** Delete session_locks/<id>.lock (holder already dead — lets devin reclaim). */
export function removeLock(sessionId: string): boolean {
  try {
    unlinkSync(join(DEVIN_CLI_DIR, "session_locks", `${sessionId}.lock`));
    return true;
  } catch {
    return false;
  }
}

function cmdlineOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

function ppidOf(pid: number): number | null {
  try {
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/^PPid:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM the lock holder — plus its parent when the parent is a `devin`
 *  CLI/TUI process (it spawned the `devin acp` that holds the lock). Escalates
 *  to SIGKILL after graceMs. Returns the pids that were signalled.
 *  Every signal re-reads the target's cmdline first: the devin process may
 *  have exited between lockOwner() and now, and its pid could already belong
 *  to an unrelated process that must never be signalled. */
export async function killLockOwner(owner: LockOwner, graceMs = 1500): Promise<number[]> {
  // a live pid whose cmdline is not devin means the lock is stale and the pid
  // was reused by an unrelated process — never signal it
  if (!owner.isDevin) return [];
  const targets = [owner.pid];
  const ppid = owner.pid ? ppidOf(owner.pid) : null;
  if (ppid && isDevinCmdline(cmdlineOf(ppid))) targets.push(ppid);
  const stillDevin = (pid: number) => isDevinCmdline(cmdlineOf(pid));
  const killed: number[] = [];
  for (const pid of targets) {
    try {
      if (!stillDevin(pid)) continue;
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      /* already dead */
    }
  }
  for (const pid of targets) {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await sleep(50);
      } catch {
        break; // dead
      }
    }
    try {
      if (stillDevin(pid)) process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  return killed;
}
