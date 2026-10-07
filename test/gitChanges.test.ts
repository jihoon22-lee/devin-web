import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  changedFiles, COMMIT_TIMEOUT_MS, commitStaged, filePatch, isSafeRelPath, parseNumstatZ,
  parsePorcelainZ, revertFile, stageFile, unstageFile,
} from "../lib/gitChanges";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** temp repo; `commit` adds base.txt ("one") in an initial commit */
function repo(commit: boolean) {
  const d = mkdtempSync(join(tmpdir(), "dw-git-"));
  dirs.push(d);
  const g = (...args: string[]) =>
    execFileSync("git", ["-C", d, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  g("init", "-q");
  if (commit) {
    writeFileSync(join(d, "base.txt"), "one\n");
    g("add", ".");
    g("commit", "-qm", "init");
  }
  return { d, g };
}

describe("parsers", () => {
  it("parsePorcelainZ handles renames and spaces", () => {
    expect(parsePorcelainZ("R  new name.txt\0old.txt\0?? a b.txt\0 M x\0")).toEqual([
      { path: "new name.txt", originalPath: "old.txt", status: "R", staged: true, unstaged: false },
      { path: "a b.txt", status: "??", staged: false, unstaged: true },
      { path: "x", status: "M", staged: false, unstaged: true },
    ]);
  });

  it("parsePorcelainZ splits staged vs worktree sides", () => {
    // "M " staged-only · " M" worktree-only · "MM" both · "??" untracked
    expect(parsePorcelainZ("M  a\0MM b\0?? c\0")).toEqual([
      { path: "a", status: "M", staged: true, unstaged: false },
      { path: "b", status: "MM", staged: true, unstaged: true },
      { path: "c", status: "??", staged: false, unstaged: true },
    ]);
  });

  it("parseNumstatZ handles renames and binary files", () => {
    const m = parseNumstatZ("0\t0\t\0old.txt\0new.txt\x001\t2\ta.txt\0-\t-\tbin.png\0");
    expect(m.get("new.txt")).toEqual({ additions: 0, deletions: 0 });
    expect(m.get("a.txt")).toEqual({ additions: 1, deletions: 2 });
    expect(m.get("bin.png")).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("changedFiles / filePatch", () => {
  it("discards only the requested repository despite inherited Git locator variables", async () => {
    const a = repo(true), b = repo(true);
    writeFileSync(join(a.d, "base.txt"), "requested edit\n");
    writeFileSync(join(b.d, "base.txt"), "unrelated edit\n");
    vi.stubEnv("GIT_DIR", join(b.d, ".git"));
    vi.stubEnv("GIT_WORK_TREE", b.d);
    vi.stubEnv("GIT_INDEX_FILE", join(b.d, ".git/index"));
    try { await revertFile(a.d, "base.txt"); }
    finally { vi.unstubAllEnvs(); }
    expect(readFileSync(join(a.d, "base.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(b.d, "base.txt"), "utf8")).toBe("unrelated edit\n");
  });

  it("reverts both paths of a staged rename without leaving a staged deletion", async () => {
    const { d, g } = repo(true);
    g("mv", "base.txt", "한글 [new].txt");
    writeFileSync(join(d, "한글 [new].txt"), "one\nedit\n");
    await revertFile(d, "한글 [new].txt");
    expect(g("status", "--porcelain").toString()).toBe("");
    expect(readFileSync(join(d, "base.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(d, "한글 [new].txt"))).toBe(false);
  });

  it("unstages both rename paths while preserving the worktree content", async () => {
    const { d, g } = repo(true);
    g("mv", "base.txt", "new name.txt");
    await unstageFile(d, "new name.txt");
    expect(g("diff", "--cached", "--name-only").toString()).toBe("");
    expect(readFileSync(join(d, "new name.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(d, "base.txt"))).toBe(false);
  });
  it("lists Korean file names verbatim and diffs them", async () => {
    const { d, g } = repo(true);
    writeFileSync(join(d, "한글 파일.txt"), "안녕\n");
    g("add", "한글 파일.txt");
    expect(await changedFiles(d)).toContainEqual({
      path: "한글 파일.txt",
      status: "A",
      staged: true,
      unstaged: false,
      additions: 1,
      deletions: 0,
    });
    expect(await filePatch(d, "한글 파일.txt")).toContain("+안녕");
  });

  it("works in a repository without commits", async () => {
    const { d, g } = repo(false);
    writeFileSync(join(d, "a.txt"), "x\n");
    g("add", "a.txt");
    expect((await changedFiles(d)).map((f) => f.path)).toEqual(["a.txt"]);
    expect(await filePatch(d, "a.txt")).toContain("+x");
  });

  it("diffs untracked files against /dev/null", async () => {
    const { d } = repo(true);
    writeFileSync(join(d, "new.txt"), "fresh\n");
    expect(await changedFiles(d)).toContainEqual({
      path: "new.txt",
      status: "??",
      staged: false,
      unstaged: true,
      additions: 0,
      deletions: 0,
    });
    expect(await filePatch(d, "new.txt")).toContain("+fresh");
  });

  it("reports a staged rename under its new path", async () => {
    const { d, g } = repo(true);
    g("mv", "base.txt", "moved.txt");
    const files = await changedFiles(d);
    expect(files.map((f) => f.path)).toEqual(["moved.txt"]);
    expect(files[0].status).toBe("R");
  });

  it("distinguishes staged-only, worktree-only and mixed states", async () => {
    const { d, g } = repo(true);
    writeFileSync(join(d, "staged.txt"), "s\n");
    g("add", "staged.txt");
    writeFileSync(join(d, "base.txt"), "two\n"); // worktree-only modify
    writeFileSync(join(d, "both.txt"), "b1\n");
    g("add", "both.txt");
    writeFileSync(join(d, "both.txt"), "b2\n"); // now staged AND unstaged
    const files = await changedFiles(d);
    const by = new Map(files.map((f) => [f.path, f]));
    expect(by.get("staged.txt")).toMatchObject({ staged: true, unstaged: false });
    expect(by.get("base.txt")).toMatchObject({ staged: false, unstaged: true });
    expect(by.get("both.txt")).toMatchObject({ staged: true, unstaged: true });
  });
});

describe("isSafeRelPath", () => {
  it("rejects traversal and absolute paths but allows dotted names", () => {
    expect(isSafeRelPath("a/..b/c..d.txt")).toBe(true);
    expect(isSafeRelPath("../x")).toBe(false);
    expect(isSafeRelPath("a/../../x")).toBe(false);
    expect(isSafeRelPath("/etc/passwd")).toBe(false);
    expect(isSafeRelPath("")).toBe(false);
  });
});

describe("pathspec safety — paths are literal (H1)", () => {
  it("Revert on app/[id]/route.ts leaves the glob-matching app/i/route.ts alone", async () => {
    const { d, g } = repo(true);
    mkdirSync(join(d, "app", "[id]"), { recursive: true });
    mkdirSync(join(d, "app", "i"), { recursive: true });
    writeFileSync(join(d, "app", "[id]", "route.ts"), "one\n");
    writeFileSync(join(d, "app", "i", "route.ts"), "other\n");
    g("add", ".");
    g("commit", "-qm", "routes");
    writeFileSync(join(d, "app", "[id]", "route.ts"), "one\nchanged\n");
    writeFileSync(join(d, "app", "i", "route.ts"), "other\nkeep me\n");

    await revertFile(d, "app/[id]/route.ts");

    expect(readFileSync(join(d, "app", "[id]", "route.ts"), "utf8")).toBe("one\n");
    expect(readFileSync(join(d, "app", "i", "route.ts"), "utf8")).toBe("other\nkeep me\n");
  });

  it("Revert on an untracked file literally named '*' deletes only that file", async () => {
    const { d } = repo(true);
    writeFileSync(join(d, "*"), "x\n");
    writeFileSync(join(d, "precious.txt"), "keep\n");

    await revertFile(d, "*");

    expect(existsSync(join(d, "*"))).toBe(false);
    expect(existsSync(join(d, "precious.txt"))).toBe(true);
  });

  it("Stage on app/[id]/route.ts stages only that file", async () => {
    const { d, g } = repo(true);
    mkdirSync(join(d, "app", "[id]"), { recursive: true });
    mkdirSync(join(d, "app", "d"), { recursive: true });
    writeFileSync(join(d, "app", "[id]", "route.ts"), "a\n");
    writeFileSync(join(d, "app", "d", "route.ts"), "b\n");

    await stageFile(d, "app/[id]/route.ts");

    expect(g("diff", "--cached", "--name-only").toString().trim().split("\n")).toEqual([
      "app/[id]/route.ts",
    ]);
  });
});

describe("commit timeout (L4)", () => {
  /** repo with author config + a pre-commit hook that sleeps 1s */
  function slowHookRepo() {
    const { d, g } = repo(true);
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    writeFileSync(join(d, ".git", "hooks", "pre-commit"), "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
    writeFileSync(join(d, "a.txt"), "a\n");
    g("add", "a.txt");
    return { d, g };
  }

  it("commits get a long default budget — hooks and GPG signing outlive 10s", () => {
    expect(COMMIT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("the budget reaches git: 300ms kills a 1s hook", async () => {
    const { d } = slowHookRepo();
    await expect(commitStaged(d, "too slow", 300)).rejects.toThrow();
  });

  it("a slow hook commits under the default budget", async () => {
    const { d, g } = slowHookRepo();
    await commitStaged(d, "slow hook ok");
    expect(g("log", "-1", "--format=%s").toString().trim()).toBe("slow hook ok");
  }, 10_000);
});


describe("session cwd below the repository root", () => {
  it("diffs, stages, unstages and reverts the listed path without touching its nested namesake", async () => {
    const { d, g } = repo(true);
    mkdirSync(join(d, "pkg", "pkg"), { recursive: true });
    writeFileSync(join(d, "pkg", "a.txt"), "target original\n");
    writeFileSync(join(d, "pkg", "pkg", "a.txt"), "other original\n");
    g("add", "."); g("commit", "-qm", "nested files");
    writeFileSync(join(d, "pkg", "a.txt"), "target changed\n");
    writeFileSync(join(d, "pkg", "pkg", "a.txt"), "other changed\n");
    const cwd = join(d, "pkg");
    const file = (await changedFiles(cwd)).find((f) => f.path === "pkg/a.txt")!;
    expect(await filePatch(cwd, file.path)).toContain("+target changed");
    await stageFile(cwd, file.path);
    expect(g("diff", "--cached", "--name-only").toString().trim()).toBe("pkg/a.txt");
    await unstageFile(cwd, file.path);
    expect(g("diff", "--cached", "--name-only").toString()).toBe("");
    await revertFile(cwd, file.path);
    expect(readFileSync(join(d, "pkg", "a.txt"), "utf8")).toBe("target original\n");
    expect(readFileSync(join(d, "pkg", "pkg", "a.txt"), "utf8")).toBe("other changed\n");
    writeFileSync(join(d, "pkg", "new.txt"), "new content\n");
    expect(await filePatch(cwd, "pkg/new.txt")).toContain("+new content");
    await revertFile(cwd, "pkg/new.txt");
    expect(existsSync(join(d, "pkg", "new.txt"))).toBe(false);
  });
});
