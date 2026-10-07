import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/revertTrash resolves DEVIN_WEB_STATE_DIR at import — temp dir first
const stateDir = mkdtempSync(join(tmpdir(), "dw-trash-state-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;
const cwd = mkdtempSync(join(tmpdir(), "dw-trash-cwd-"));
afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const { backupBeforeRevert, pruneTrash, undoRevert } = await import("../lib/revertTrash");

describe("revert undo (E1)", () => {
  it("restores the bytes a revert discarded", () => {
    writeFileSync(join(cwd, "a.txt"), "my edit\n");
    const id = backupBeforeRevert(cwd, "a.txt");
    writeFileSync(join(cwd, "a.txt"), "HEAD\n"); // what `git restore` leaves behind
    expect(undoRevert(id, cwd).file).toBe("a.txt");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("my edit\n");
  });

  it("re-deletes a file that did not exist before the revert", () => {
    const id = backupBeforeRevert(cwd, "gone.txt"); // a worktree-deleted file
    writeFileSync(join(cwd, "gone.txt"), "restored by git\n");
    undoRevert(id, cwd);
    expect(existsSync(join(cwd, "gone.txt"))).toBe(false);
  });

  it("refuses an undo id from another session's tree, and malformed ids", () => {
    writeFileSync(join(cwd, "b.txt"), "x\n");
    const id = backupBeforeRevert(cwd, "b.txt");
    const other = mkdtempSync(join(tmpdir(), "dw-trash-other-"));
    expect(() => undoRevert(id, other)).toThrow(/another session/);
    expect(() => undoRevert("../../etc", cwd)).toThrow(/bad undo id/);
    rmSync(other, { recursive: true, force: true });
  });

  it("keeps at most 50 backups", () => {
    mkdirSync(join(cwd, "many"), { recursive: true });
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(cwd, "many", `${i}.txt`), String(i));
      backupBeforeRevert(cwd, `many/${i}.txt`);
    }
    pruneTrash();
    expect(readdirSync(join(stateDir, "revert-trash")).length).toBeLessThanOrEqual(50);
  });
});
