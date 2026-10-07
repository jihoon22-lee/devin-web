import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHooks } from "../bin/install-hooks.mjs";

let dirs: string[] = [];
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "dw-hooks-"));
  dirs.push(d);
  return d;
};
const silent = () => {}; // log sink — tests capture their own
const hook = (root: string) => join(root, ".git/hooks/pre-push");

afterEach(() => {
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
    const root = mk();
    mkdirSync(join(root, ".git"));
    expect(installHooks({ root, log: silent })).toBe(0);
    const p = hook(root);
    expect(readFileSync(p, "utf8")).toContain("exec pnpm verify");
    expect(statSync(p).mode & 0o111).not.toBe(0);
  });

  it("a DIFFERENT existing hook is kept, with a warning", () => {
    const root = mk();
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    writeFileSync(hook(root), "#!/bin/sh\necho mine\n");
    const msgs: string[] = [];
    expect(installHooks({ root, log: (m: unknown) => msgs.push(String(m)) })).toBe(0);
    expect(readFileSync(hook(root), "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(msgs.some((m) => m.includes("different content"))).toBe(true);
  });

  it("an identical hook is left in place (exec bit enforced, no warning)", () => {
    const root = mk();
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    writeFileSync(hook(root), "#!/bin/sh\n# devin-web: never push unverified work (also enforced by GitHub CI)\nexec pnpm verify\n", { mode: 0o644 });
    const msgs: string[] = [];
    expect(installHooks({ root, log: (m: unknown) => msgs.push(String(m)) })).toBe(0);
    expect(msgs).toHaveLength(0);
    expect(statSync(hook(root)).mode & 0o111).not.toBe(0);
  });

  it("worktree gitfile (gitdir: <path>) installs into the real git dir", () => {
    const root = mk();
    const gitdir = mkdtempSync(join(tmpdir(), "dw-gitdir-"));
    dirs.push(gitdir);
    writeFileSync(join(root, ".git"), `gitdir: ${gitdir}\n`);
    expect(installHooks({ root, log: silent })).toBe(0);
    expect(readFileSync(join(gitdir, "hooks/pre-push"), "utf8")).toContain("exec pnpm verify");
  });
});
