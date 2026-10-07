import { afterAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = vi.hoisted(() => ({ cwd: "" }));
vi.mock("@/lib/state", () => ({ manager: () => ({ getSession: () => live }) }));
const dir = mkdtempSync(join(tmpdir(), "dw-changes-route-"));
process.env.DEVIN_WEB_STATE_DIR = join(dir, "state");
const { POST } = await import("../app/api/sessions/[id]/changes/route");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("backs up and restores repository-relative paths for a nested session cwd", async () => {
  const root = join(dir, "repo");
  live.cwd = join(root, "pkg");
  mkdirSync(live.cwd, { recursive: true });
  const g = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  g("init", "-q");
  const file = join(live.cwd, "a.txt");
  writeFileSync(file, "original");
  g("add", "."); g("commit", "-qm", "base");
  writeFileSync(file, "changed");
  const post = (body: object) => POST(new Request("http://localhost/api/sessions/s/changes", {
    method: "POST", body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "s" }) });
  const reverted = await post({ action: "revert", file: "pkg/a.txt" });
  expect(reverted.status).toBe(200);
  expect(readFileSync(file, "utf8")).toBe("original");
  const { undoId } = await reverted.json();
  expect((await post({ action: "undo", undoId })).status).toBe(200);
  expect(readFileSync(file, "utf8")).toBe("changed");
});

it("undo restores both worktree paths of a discarded rename without re-staging it", async () => {
  const root = join(dir, "rename-repo");
  mkdirSync(root); live.cwd = root;
  const g = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  g("init", "-q");
  writeFileSync(join(root, "old.txt"), "base\n");
  g("add", "."); g("commit", "-qm", "base");
  g("mv", "old.txt", "new [한글].txt");
  writeFileSync(join(root, "new [한글].txt"), "base\nedited\n");
  const post = (body: object) => POST(new Request("http://localhost/api/sessions/s/changes", {
    method: "POST", body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "s" }) });
  const reverted = await post({ action: "revert", file: "new [한글].txt" });
  expect(reverted.status).toBe(200);
  expect(g("status", "--porcelain").toString()).toBe("");
  const { undoId } = await reverted.json();
  expect((await post({ action: "undo", undoId })).status).toBe(200);
  expect(existsSync(join(root, "old.txt"))).toBe(false);
  expect(readFileSync(join(root, "new [한글].txt"), "utf8")).toBe("base\nedited\n");
  expect(g("diff", "--cached", "--name-only").toString()).toBe("");
});
