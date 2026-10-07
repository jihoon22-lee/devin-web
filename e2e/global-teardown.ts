import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface ReapDeps {
  /** /proc/<pid>/cmdline contents (NUL-separated argv), or null when
   *  unreadable — a missing /proc means we can't verify, so we don't kill. */
  readCmdline?: (pid: number) => string | null;
  kill?: (pid: number, signal: string) => void;
  rm?: (path: string) => void;
}

const realReadCmdline = (pid: number): string | null => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
};

/** The holder is `bash -c "exec -a devin sleep 7200"` — argv becomes
 *  ["devin", "7200"]. Match that shape exactly: argv0 "devin" plus one
 *  numeric arg. A real devin CLI has argv0 "devin" too, but its args are
 *  subcommands ("acp", "auth", …), never a bare number. */
const isFixtureHolder = (cmdline: string | null): boolean => {
  if (cmdline === null) return false;
  const argv = cmdline.split("\0").filter((a) => a !== "");
  return argv[0] === "devin" && argv.length === 2 && /^\d+$/.test(argv[1]);
};

/** Reap the fake `devin` lock-holder spawned by make-fixture.mjs — but only
 *  after verifying it still IS the holder. A stale pidfile + a recycled pid
 *  must be a silent skip, never a blind SIGKILL at an innocent process. */
export function reapLockHolder(pidFile: string, deps: ReapDeps = {}) {
  const readCmdline = deps.readCmdline ?? realReadCmdline;
  const kill = deps.kill ?? ((pid: number, sig: string) => process.kill(pid, sig));
  const rm = deps.rm ?? ((p: string) => rmSync(p, { force: true }));
  let pid: number;
  try {
    pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  } catch {
    return; // pidfile missing — fixture never built or already cleaned
  }
  if (!Number.isFinite(pid) || !isFixtureHolder(readCmdline(pid))) return;
  try {
    kill(pid, "SIGKILL");
  } catch {
    return; // raced the holder's own exit — nothing to clean up anyway
  }
  rm(pidFile);
}

export default function globalTeardown() {
  reapLockHolder(join(process.cwd(), ".e2e-fixture", "lock-holder.pid"));
  rmSync(join(process.cwd(), ".e2e-fixture", "turn-script.json"), { force: true });
}
