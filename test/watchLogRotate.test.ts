import { describe, expect, it } from "vitest";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// IS_MAIN guard keeps the import side-effect-free; the function under test
// takes its paths as arguments anyway
const dir = mkdtempSync(join(tmpdir(), "dw-watch-"));
process.env.DEVIN_WEB_STATE_DIR = dir;

const { rotateServiceLog } = await import("../bin/devin-web-watch.mjs");

describe("devin-web-watch service-log rotation", () => {
  it("copytruncates a fat log — a writer holding the fd keeps writing in place", () => {
    const log = join(dir, "server.log");
    const fat = "x".repeat(6 * 1024 * 1024);
    writeFileSync(log, fat);
    // simulate the running server's append fd — rename() would strand it,
    // copytruncate must not
    const fd = openSync(log, "a");
    try {
      expect(rotateServiceLog(log)).toBe(true);
      writeSync(fd, "after-rotate\n");
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(`${log}.1`, "utf8")).toBe(fat);
    expect(readFileSync(log, "utf8")).toBe("after-rotate\n");
  });

  it("leaves a small log alone and never throws on a missing one", () => {
    const log = join(dir, "small.log");
    writeFileSync(log, "few lines\n");
    expect(rotateServiceLog(log)).toBe(false);
    expect(readFileSync(log, "utf8")).toBe("few lines\n");
    expect(rotateServiceLog(join(dir, "missing.log"))).toBe(false);
  });

  it("keeps one generation — a second rotation overwrites .1", () => {
    const log = join(dir, "gen.log");
    writeFileSync(log, "a".repeat(6 * 1024 * 1024));
    expect(rotateServiceLog(log)).toBe(true);
    writeFileSync(log, "b".repeat(6 * 1024 * 1024));
    expect(rotateServiceLog(log)).toBe(true);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("b".repeat(6 * 1024 * 1024));
  });
});

import { afterAll } from "vitest";
afterAll(() => rmSync(dir, { recursive: true, force: true }));
