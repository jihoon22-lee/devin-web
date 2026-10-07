import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/archive resolves DEVIN_WEB_STATE_DIR at module load — set it first
const stateDir = mkdtempSync(join(tmpdir(), "dw-archive-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

const archive = await import("../lib/archive");

describe("lib/archive", () => {
  it("archives and restores a session", () => {
    expect(archive.isArchived("s1")).toBe(false);
    expect(archive.setArchived("s1", true)).toBe(true);
    expect(archive.isArchived("s1")).toBe(true);
    expect(archive.setArchived("s1", false)).toBe(true);
    expect(archive.isArchived("s1")).toBe(false);
  });

  it("persists across a module reload (survives restart)", async () => {
    archive.setArchived("s2", true);
    vi.resetModules();
    const fresh = await import("../lib/archive");
    expect(fresh.isArchived("s2")).toBe(true);
    expect(fresh.archivedMap()["s2"]).toBeTypeOf("number");
  });

  it("rejects non-boolean input", () => {
    expect(archive.setArchived("s3", "yes" as unknown as boolean)).toBeNull();
    expect(archive.isArchived("s3")).toBe(false);
  });
});
