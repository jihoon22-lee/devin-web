import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const stateDir = mkdtempSync(join(tmpdir(), "dw-wt-state-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;
const dirs: string[] = [stateDir];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const wt = await import("../lib/worktrees");

/** temp repo with one commit; returns {d, g} like gitChanges.test.ts */
function repo() {
  const d = mkdtempSync(join(tmpdir(), "dw-wt-repo-"));
  dirs.push(d);
  const g = (...args: string[]) =>
    execFileSync("git", ["-C", d, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  g("init", "-q");
  writeFileSync(join(d, "base.txt"), "one\n");
  g("add", ".");
  g("commit", "-qm", "init");
  return { d, g };
}

describe("lib/worktrees", () => {
  it("createWorktree adds a worktree on a fresh devin-web/* branch", async () => {
    const { d, g } = repo();
    const w = await wt.createWorktree(d, "sess-1");
    expect(w.repo).toBe(d);
    expect(w.branch).toMatch(/^devin-web\//);
    expect(w.path).toContain(join(stateDir, "worktrees"));
    expect(existsSync(join(w.path, "base.txt"))).toBe(true);
    // the branch really exists and is checked out in the worktree
    expect(g("branch", "--list", w.branch).toString()).toContain(w.branch);
    expect(
      execFileSync("git", ["-C", w.path, "rev-parse", "--abbrev-ref", "HEAD"]).toString().trim(),
    ).toBe(w.branch);
    // recorded, keyed by path, bound to the session
    expect(wt.worktreeForCwd(w.path)).toMatchObject({ branch: w.branch, sessionId: "sess-1" });
    // the original repo is untouched — still on its own branch, no new files
    expect(g("status", "--porcelain").toString().trim()).toBe("");
  });

  it("rejects a non-git directory", async () => {
    const d = mkdtempSync(join(tmpdir(), "dw-wt-notgit-"));
    dirs.push(d);
    await expect(wt.createWorktree(d, "s")).rejects.toThrow(/git/i);
  });

  it("two worktrees in one repo never collide on path or branch", async () => {
    const { d, g } = repo();
    const a = await wt.createWorktree(d, "a");
    const b = await wt.createWorktree(d, "b");
    expect(a.path).not.toBe(b.path);
    expect(a.branch).not.toBe(b.branch);
    expect(g("worktree", "list", "--porcelain").toString()).toContain(a.path);
  });

  it("listWorktrees reports dirty state", async () => {
    const { d } = repo();
    const w = await wt.createWorktree(d, "s-dirty");
    const clean = wt.listWorktrees().find((x) => x.path === w.path);
    expect(clean).toMatchObject({ dirty: false, branch: w.branch });
    writeFileSync(join(w.path, "dirty.txt"), "x\n");
    expect(wt.listWorktrees().find((x) => x.path === w.path)).toMatchObject({ dirty: true });
  });

  it("removeWorktree refuses a dirty worktree and keeps the record", async () => {
    const { d } = repo();
    const w = await wt.createWorktree(d, "s-dirty2");
    writeFileSync(join(w.path, "dirty.txt"), "x\n");
    await expect(wt.removeWorktree(w.path)).rejects.toThrow();
    expect(existsSync(w.path)).toBe(true);
    expect(wt.worktreeForCwd(w.path)).not.toBeNull();
  });

  it("removeWorktree removes a clean worktree and its record", async () => {
    const { d, g } = repo();
    const w = await wt.createWorktree(d, "s-clean");
    await wt.removeWorktree(w.path);
    expect(existsSync(w.path)).toBe(false);
    expect(wt.worktreeForCwd(w.path)).toBeNull();
    expect(g("worktree", "list", "--porcelain").toString()).not.toContain(w.path);
  });

  it("noteSessionDeleted keeps the record but drops the session link", async () => {
    const { d } = repo();
    const w = await wt.createWorktree(d, "s-gone");
    wt.noteSessionDeleted("s-gone");
    const rec = wt.worktreeForCwd(w.path);
    expect(rec).toMatchObject({ branch: w.branch });
    expect(rec?.sessionId).toBeUndefined();
  });

  it("a corrupt worktrees.json reads as empty", () => {
    writeFileSync(join(stateDir, "worktrees.json"), "{not json");
    // invalidate the module cache path — worktreeForCwd must re-read on miss
    expect(() => wt.listWorktrees()).not.toThrow();
  });
  it("picks up external rewrites — a ctl-removed record stays gone", async () => {
    const { d } = repo();
    const a = await wt.createWorktree(d, "sa");
    const b = await wt.createWorktree(d, "sb");
    // simulate `devin-web-ctl worktrees rm`: another process rewrites the file
    const f = join(stateDir, "worktrees.json");
    const cur = JSON.parse(readFileSync(f, "utf8"));
    delete cur[a.path];
    writeFileSync(f, JSON.stringify(cur));
    // a subsequent save must not resurrect the externally-removed record
    await wt.createWorktree(d, "sc");
    const after = JSON.parse(readFileSync(f, "utf8"));
    expect(Object.keys(after)).not.toContain(a.path);
    expect(Object.keys(after)).toContain(b.path);
    expect(wt.worktreeForCwd(a.path)).toBeNull();
  });

});
