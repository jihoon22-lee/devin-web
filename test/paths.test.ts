import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stateDir } from "../lib/paths.mjs";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("stateDir (R12 C4)", () => {
  it("DEVIN_WEB_STATE_DIR wins, then XDG_STATE_HOME, then ~/.local/state", () => {
    process.env.DEVIN_WEB_STATE_DIR = "/custom";
    process.env.XDG_STATE_HOME = "/x";
    expect(stateDir()).toBe("/custom");
    delete process.env.DEVIN_WEB_STATE_DIR;
    expect(stateDir()).toBe("/x/devin-web");
    delete process.env.XDG_STATE_HOME;
    expect(stateDir()).toBe(join(homedir(), ".local", "state", "devin-web"));
  });

  it("no module resolves the state dir on its own", () => {
    const files = execFileSync("git", ["ls-files", "lib", "bin", "app"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.(ts|tsx|mjs)$/.test(f) && f !== "lib/paths.mjs");
    const pattern = /\.local["']?,\s*["']state|\.local\/state/;
    expect(files.filter((f) => pattern.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});

// A static import-time file path must not ignore a later test/development
// state override. Both candidates are temporary: never touch live state.
it("resolves derived JSON paths at first use rather than module import", async () => {
  const root = mkdtempSync(join(tmpdir(), "dw-path-lazy-"));
  try {
    process.env.DEVIN_WEB_STATE_DIR = join(root, "import-time");
    vi.resetModules();
    const ui = await import("../lib/uiState");
    process.env.DEVIN_WEB_STATE_DIR = join(root, "use-time");
    expect(ui.updateUiState({ pins: ["isolated"] })).not.toBeNull();
    expect(existsSync(join(root, "import-time", "ui-state.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "use-time", "ui-state.json"), "utf8")).pins).toEqual(["isolated"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
