// e2e lock-holder teardown: the pid in .e2e-fixture/lock-holder.pid may have
// been recycled by the OS between a crashed run and the next teardown, so the
// reaper must verify /proc/<pid>/cmdline before SIGKILL — never blind-kill.
// NOTE: cmdline fixtures are built with NUL joins — a source-level "\0"
// followed by a digit would parse as an OCTAL escape, not NUL + digit.
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { reapLockHolder } from "../e2e/global-teardown";

const NUL = String.fromCharCode(0);
const cmdline = (...argv: string[]) => argv.join(NUL) + NUL;

const pidFile = (pid = 4242) => {
  const f = join(mkdtempSync(join(tmpdir(), "dw-teardown-")), "lock-holder.pid");
  writeFileSync(f, `${pid}\n`);
  return f;
};

describe("e2e lock-holder reaper", () => {
  it("does NOT kill a pid whose cmdline is not the fixture holder", () => {
    const f = pidFile();
    const kill = vi.fn();
    // OS recycled the pid — this is an unrelated plain sleep, not our
    // `exec -a devin sleep` holder
    reapLockHolder(f, { readCmdline: () => cmdline("sleep", "7200"), kill });
    expect(kill).not.toHaveBeenCalled();
  });

  it("does NOT kill a real devin CLI (argv0=devin but real args, not sleep)", () => {
    const f = pidFile();
    const kill = vi.fn();
    reapLockHolder(f, { readCmdline: () => cmdline("devin", "acp"), kill });
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills the pid when cmdline matches `exec -a devin sleep <secs>`", () => {
    const f = pidFile();
    const kill = vi.fn();
    reapLockHolder(f, { readCmdline: () => cmdline("devin", "7200"), kill });
    expect(kill).toHaveBeenCalledWith(4242, "SIGKILL");
    // pidfile removed so the next run never re-reads a stale pid
    expect(existsSync(f)).toBe(false);
  });

  it("treats an unreadable /proc cmdline as not-the-holder (no /proc → no kill)", () => {
    const f = pidFile();
    const kill = vi.fn();
    reapLockHolder(f, { readCmdline: () => null, kill });
    expect(kill).not.toHaveBeenCalled();
  });

  it("does nothing when the pidfile is absent or garbage", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "dw-teardown-")), "nope.pid");
    const kill = vi.fn();
    expect(() => reapLockHolder(missing, { kill })).not.toThrow();
    const garbage = pidFile();
    writeFileSync(garbage, "not-a-pid\n");
    expect(() => reapLockHolder(garbage, { kill })).not.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });
});
