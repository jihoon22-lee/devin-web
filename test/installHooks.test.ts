import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHooks } from "../bin/install-hooks.mjs";

let dirs: string[] = [];
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "dw-hooks-"));
  dirs.push(d);
  return d;
};
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const repo = () => { const root = mk(); git(root, "init", "-q"); return root; };
const silent = () => {}; // log sink — tests capture their own
const hook = (root: string) => join(root, ".git/hooks/pre-push");

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_COUNT", undefined);
  vi.stubEnv("GIT_CONFIG_PARAMETERS", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("install-hooks", () => {
  it("no .git (tarball/exported tree) → quietly succeeds", () => {
    const root = mk();
    expect(installHooks({ root, log: silent })).toBe(0);
    expect(existsSync(hook(root))).toBe(false);
  });

  it("fresh clone (.git dir, no hook) → writes an executable pre-push", () => {
    const root = repo();
    expect(installHooks({ root, log: silent })).toBe(0);
    const p = hook(root);
    expect(readFileSync(p, "utf8")).toContain("exec pnpm verify");
    expect(statSync(p).mode & 0o111).not.toBe(0);
  });

  it("a DIFFERENT existing hook is kept, with a warning", () => {
    const root = repo();
    writeFileSync(hook(root), "#!/bin/sh\necho mine\n");
    const msgs: string[] = [];
    expect(installHooks({ root, log: (m: unknown) => msgs.push(String(m)) })).toBe(0);
    expect(readFileSync(hook(root), "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(msgs.some((m) => m.includes("different content"))).toBe(true);
  });

  it("an identical hook is left in place (exec bit enforced, no warning)", () => {
    const root = repo();
    writeFileSync(hook(root), "#!/bin/sh\n# devin-web: never push unverified work (also enforced by GitHub CI)\nexec pnpm verify\n", { mode: 0o644 });
    const msgs: string[] = [];
    expect(installHooks({ root, log: (m: unknown) => msgs.push(String(m)) })).toBe(0);
    expect(msgs).toHaveLength(0);
    expect(statSync(hook(root)).mode & 0o111).not.toBe(0);
  });

  it("ignores inherited repository locators when installing in a different root", () => {
    const root = repo(), foreign = repo();
    vi.stubEnv("GIT_DIR", join(foreign, ".git"));
    vi.stubEnv("GIT_WORK_TREE", foreign);
    vi.stubEnv("GIT_COMMON_DIR", join(foreign, ".git"));
    vi.stubEnv("GIT_INDEX_FILE", join(foreign, ".git/index"));
    installHooks({ root, log: silent });
    expect(existsSync(hook(root))).toBe(true);
    expect(existsSync(hook(foreign))).toBe(false);
  });
  it.each(["global", "environment"])("preserves intentional %s core.hooksPath configuration", (kind) => {
    const root = repo(); const dir = join(mk(), "hooks");
    if (kind === "global") {
      const config = join(mk(), "gitconfig");
      writeFileSync(config, `[core]\n  hooksPath = ${dir}\n`);
      vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    } else {
      vi.stubEnv("GIT_CONFIG_COUNT", "1");
      vi.stubEnv("GIT_CONFIG_KEY_0", "core.hooksPath");
      vi.stubEnv("GIT_CONFIG_VALUE_0", dir);
    }
    installHooks({ root, log: silent });
    expect(readFileSync(join(dir, "pre-push"), "utf8")).toContain("exec pnpm verify");
    expect(existsSync(hook(root))).toBe(false);
  });
  it("linked worktree installs in Git's common hooks directory", () => {
    const main = repo();
    git(main, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "init");
    const root = join(mk(), "worktree");
    git(main, "worktree", "add", "--detach", root);
    expect(installHooks({ root, log: silent })).toBe(0);
    expect(readFileSync(hook(main), "utf8")).toContain("exec pnpm verify");
    expect(git(root, "rev-parse", "--git-path", "hooks/pre-push")).toBe(hook(main));
  });
  it.each([false, true])("uses effective core.hooksPath (absolute=%s) and preserves an existing custom hook", (absolute) => {
    const root = repo(); const dir = absolute ? join(mk(), "custom-hooks") : "custom-hooks";
    git(root, "config", "core.hooksPath", dir);
    const target = absolute ? dir : join(root, dir);
    installHooks({ root, log: silent });
    expect(readFileSync(join(target, "pre-push"), "utf8")).toContain("exec pnpm verify");
    expect(existsSync(hook(root))).toBe(false);
    writeFileSync(join(target, "pre-push"), "#!/bin/sh\necho custom\n");
    const msgs: string[] = [];
    installHooks({ root, log: (m: unknown) => msgs.push(String(m)) });
    expect(readFileSync(join(target, "pre-push"), "utf8")).toContain("echo custom");
    expect(msgs.join(" ")).toContain("different content");
  });
});
