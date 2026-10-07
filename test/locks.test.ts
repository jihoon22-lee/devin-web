import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isDevinCmdline, killLockOwner } from "../lib/locks";

describe("isDevinCmdline", () => {
  it("recognizes devin binaries by argv0", () => {
    expect(isDevinCmdline("/home/u/.local/share/devin/cli/_versions/3000.10.31/bin/devin acp")).toBe(true);
    expect(isDevinCmdline("devin -r abc")).toBe(true);
  });
  it("rejects anything else, including unreadable cmdlines", () => {
    expect(isDevinCmdline("/usr/bin/vim devin")).toBe(false);
    expect(isDevinCmdline("/opt/devintools/run")).toBe(false);
    expect(isDevinCmdline("")).toBe(false);
  });
});

describe("killLockOwner", () => {
  it("refuses to signal a pid that is not a devin process (pid reuse)", async () => {
    const child = spawn("sleep", ["30"]);
    try {
      const killed = await killLockOwner(
        { pid: child.pid!, cmdline: "sleep 30", alive: true, ours: false, isDevin: false },
        100,
      );
      expect(killed).toEqual([]);
      expect(child.exitCode).toBeNull();
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("re-checks cmdline before each signal — a stale 'devin' owner is never killed", async () => {
    // the owner claims to be devin (isDevin was true at lockOwner() time), but
    // by the time killLockOwner runs /proc says `sleep` — the pid was reused
    const child = spawn("sleep", ["30"]);
    try {
      const killed = await killLockOwner(
        { pid: child.pid!, cmdline: "/opt/devin/_versions/3000/bin/devin acp", alive: true, ours: false, isDevin: true },
        100,
      );
      expect(killed).toEqual([]); // re-check refused to signal
      expect(() => process.kill(child.pid!, 0)).not.toThrow(); // still alive
    } finally {
      child.kill("SIGKILL");
    }
  });
});
