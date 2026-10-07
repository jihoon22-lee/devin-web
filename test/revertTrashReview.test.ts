import { afterAll, afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const control = vi.hoisted(() => ({ cwd: "", afterBackup: undefined as (() => void) | undefined, afterRemoveFailure: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, rmSync: (...args: Parameters<typeof actual.rmSync>) => {
    try { return actual.rmSync(...args); }
    catch (e) { control.afterRemoveFailure?.(); throw e; }
  } };
});
vi.mock("@/lib/state", () => ({ manager: () => ({ getSession: () => ({ cwd: control.cwd }) }) }));
vi.mock("@/lib/revertTrash", async (original) => {
  const actual = await original<typeof import("../lib/revertTrash")>();
  return { ...actual, backupBeforeRevert: (...args: Parameters<typeof actual.backupBeforeRevert>) => {
    const id = actual.backupBeforeRevert(...args);
    control.afterBackup?.();
    return id;
  } };
});
const dir = mkdtempSync(join(tmpdir(), "dw-revert-review-"));
process.env.DEVIN_WEB_STATE_DIR = join(dir, "state");
const { backupBeforeRevert, undoRevert } = await import("../lib/revertTrash");
const { POST } = await import("../app/api/sessions/[id]/changes/route");
afterEach(() => { control.afterBackup = undefined; control.afterRemoveFailure = undefined; });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("leaves both rename paths unchanged when the second undo destination is unwritable", () => {
  const cwd = join(dir, "partial-undo");
  const parent = join(cwd, "source");
  mkdirSync(parent, { recursive: true });
  writeFileSync(join(cwd, "new.txt"), "edited rename content");
  const id = backupBeforeRevert(cwd, "new.txt", ["source/old.txt"]);
  rmSync(join(cwd, "new.txt"));
  writeFileSync(join(parent, "old.txt"), "HEAD content");
  chmodSync(parent, 0o555);
  try {
    expect(() => undoRevert(id, cwd)).toThrow();
    expect(existsSync(join(process.env.DEVIN_WEB_STATE_DIR!, "revert-trash", id))).toBe(true);
    expect(existsSync(join(cwd, "new.txt"))).toBe(false);
    expect(readFileSync(join(parent, "old.txt"), "utf8")).toBe("HEAD content");
  } finally { chmodSync(parent, 0o755); }
});

it("does not discard a newly selected rename source which was absent from the backup", async () => {
  const cwd = join(dir, "concurrent-rename");
  mkdirSync(cwd); control.cwd = cwd;
  const g = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  g("init", "-q");
  writeFileSync(join(cwd, "first.txt"), "same base\n");
  writeFileSync(join(cwd, "second.txt"), "same base\n");
  g("add", "."); g("commit", "-qm", "base");
  g("mv", "first.txt", "renamed.txt");
  // Model an independent writer at the await boundary following the safety
  // copy. The leaf bytes in renamed.txt stay unchanged; its index source does not.
  control.afterBackup = () => {
    g("reset", "--mixed", "HEAD");
    g("add", "renamed.txt");
    g("rm", "--cached", "second.txt");
    writeFileSync(join(cwd, "second.txt"), "new independent work\n");
  };
  const post = (body: object) => POST(new Request("http://localhost/api/sessions/s/changes", {
    method: "POST", body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "s" }) });
  const reverted = await post({ action: "revert", file: "renamed.txt" });
  control.afterBackup = undefined;
  if (reverted.status === 200) {
    const { undoId } = await reverted.json();
    expect((await post({ action: "undo", undoId })).status).toBe(200);
  }
  expect(readFileSync(join(cwd, "second.txt"), "utf8")).toBe("new independent work\n");
});

it("keeps rename worktree content accessible for recovery when git restore fails", async () => {
  const cwd = join(dir, "failed-revert");
  const parent = join(cwd, "source");
  mkdirSync(parent, { recursive: true }); control.cwd = cwd;
  const g = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  g("init", "-q");
  writeFileSync(join(parent, "old.txt"), "base\n");
  g("add", "."); g("commit", "-qm", "base");
  g("mv", "source/old.txt", "renamed.txt");
  writeFileSync(join(cwd, "renamed.txt"), "base\nmy edit\n");
  chmodSync(parent, 0o555);
  try {
    const result = await POST(new Request("http://localhost/api/sessions/s/changes", {
      method: "POST", body: JSON.stringify({ action: "revert", file: "renamed.txt" }),
    }), { params: Promise.resolve({ id: "s" }) });
    expect(result.status).toBe(500);
    const body = await result.json();
    const originalStillPresent = existsSync(join(cwd, "renamed.txt")) && readFileSync(join(cwd, "renamed.txt"), "utf8") === "base\nmy edit\n";
    expect(originalStillPresent || typeof body.undoId === "string").toBe(true);
  } finally { chmodSync(parent, 0o755); }
});


it("retains both backup manifests and reports the recovery directory if compensation fails too", () => {
  const cwd = join(dir, "failed-compensation");
  const parent = join(cwd, "source");
  mkdirSync(parent, { recursive: true });
  writeFileSync(join(cwd, "new.txt"), "original edit");
  const id = backupBeforeRevert(cwd, "new.txt", ["source/old.txt"]);
  rmSync(join(cwd, "new.txt"));
  writeFileSync(join(parent, "old.txt"), "HEAD");
  chmodSync(parent, 0o555);
  control.afterRemoveFailure = () => { chmodSync(cwd, 0o555); };
  try {
    expect(() => undoRevert(id, cwd)).toThrow(/Pre-undo recovery retained at/);
    const backup = join(process.env.DEVIN_WEB_STATE_DIR!, "revert-trash", id);
    expect(existsSync(join(backup, "meta.json"))).toBe(true);
    expect(readFileSync(join(backup, "content-0"), "utf8")).toBe("original edit");
    const recovery = readdirSync(backup).find((name) => name.startsWith("before-undo-"))!;
    expect(JSON.parse(readFileSync(join(backup, recovery, "meta.json"), "utf8")).files).toMatchObject([
      { file: "new.txt", kind: "absent" }, { file: "source/old.txt", kind: "file" },
    ]);
    expect(readFileSync(join(backup, recovery, "content-1"), "utf8")).toBe("HEAD");
  } finally { control.afterRemoveFailure = undefined; chmodSync(cwd, 0o755); chmodSync(parent, 0o755); }
});

it("rejects same-status worktree edits made after the safety copy", async () => {
  const cwd = join(dir, "concurrent-bytes");
  mkdirSync(cwd); control.cwd = cwd;
  const g = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  g("init", "-q"); writeFileSync(join(cwd, "file.txt"), "base");
  g("add", "."); g("commit", "-qm", "base");
  writeFileSync(join(cwd, "file.txt"), "first edit");
  control.afterBackup = () => writeFileSync(join(cwd, "file.txt"), "newer edit");
  const result = await POST(new Request("http://localhost/api/sessions/s/changes", {
    method: "POST", body: JSON.stringify({ action: "revert", file: "file.txt" }),
  }), { params: Promise.resolve({ id: "s" }) });
  expect(result.status).toBe(409);
  expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("newer edit");
});
