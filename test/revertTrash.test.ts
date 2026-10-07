import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  it("restores a changed symlink without writing through either target", () => {
    writeFileSync(join(cwd, "target-a"), "A");
    writeFileSync(join(cwd, "target-b"), "B");
    symlinkSync("target-b", join(cwd, "link"));
    const id = backupBeforeRevert(cwd, "link");
    rmSync(join(cwd, "link"));
    symlinkSync("target-a", join(cwd, "link"));
    undoRevert(id, cwd);
    expect(readFileSync(join(cwd, "target-a"), "utf8")).toBe("A");
    expect(readFileSync(join(cwd, "target-b"), "utf8")).toBe("B");
    expect(readlinkSync(join(cwd, "link"))).toBe("target-b");
  });

  it("preserves dangling links and executable file modes", () => {
    symlinkSync("missing-target", join(cwd, "dangling"));
    const linkId = backupBeforeRevert(cwd, "dangling");
    rmSync(join(cwd, "dangling"));
    writeFileSync(join(cwd, "dangling"), "replacement");
    undoRevert(linkId, cwd);
    expect(lstatSync(join(cwd, "dangling")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(cwd, "dangling"))).toBe("missing-target");
    writeFileSync(join(cwd, "script"), "#!/bin/sh\n");
    chmodSync(join(cwd, "script"), 0o751);
    const fileId = backupBeforeRevert(cwd, "script");
    chmodSync(join(cwd, "script"), 0o600);
    undoRevert(fileId, cwd);
    expect(statSync(join(cwd, "script")).mode & 0o777).toBe(0o751);
  });

  it("refuses restoring through a changed parent symlink and keeps recovery data", () => {
    mkdirSync(join(cwd, "parent"));
    mkdirSync(join(cwd, "unrelated"));
    writeFileSync(join(cwd, "parent", "file"), "edit");
    writeFileSync(join(cwd, "unrelated", "file"), "precious");
    const id = backupBeforeRevert(cwd, "parent/file");
    rmSync(join(cwd, "parent"), { recursive: true });
    symlinkSync("unrelated", join(cwd, "parent"));
    expect(() => undoRevert(id, cwd)).toThrow(/symlink/i);
    expect(readFileSync(join(cwd, "unrelated", "file"), "utf8")).toBe("precious");
    expect(existsSync(join(stateDir, "revert-trash", id))).toBe(true);
  });

  it("reads legacy regular backups but refuses a legacy symlink destination", () => {
    const id = "1700000000000-abcdefabcdef";
    const dir = join(stateDir, "revert-trash", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "content"), "legacy edit");
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd, file: "legacy", existed: true, at: Date.now() }));
    writeFileSync(join(cwd, "legacy-target"), "untouched");
    symlinkSync("legacy-target", join(cwd, "legacy"));
    expect(() => undoRevert(id, cwd)).toThrow(/legacy.*symlink/i);
    expect(readFileSync(join(cwd, "legacy-target"), "utf8")).toBe("untouched");
    rmSync(join(cwd, "legacy"));
    writeFileSync(join(cwd, "legacy"), "HEAD");
    undoRevert(id, cwd);
    expect(readFileSync(join(cwd, "legacy"), "utf8")).toBe("legacy edit");
  });

  it("leaves files unchanged when recovery content is missing", () => {
    writeFileSync(join(cwd, "missing-backup"), "edit");
    const id = backupBeforeRevert(cwd, "missing-backup");
    rmSync(join(stateDir, "revert-trash", id, "content-0"));
    writeFileSync(join(cwd, "missing-backup"), "HEAD");
    expect(() => undoRevert(id, cwd)).toThrow();
    expect(readFileSync(join(cwd, "missing-backup"), "utf8")).toBe("HEAD");
    expect(readdirSync(cwd).filter((p) => p.startsWith(".devin-undo-"))).toEqual([]);
    expect(existsSync(join(stateDir, "revert-trash", id))).toBe(true);
  });
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
