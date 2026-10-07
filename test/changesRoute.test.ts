import { afterAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
