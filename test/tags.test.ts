import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/tags resolves DEVIN_WEB_STATE_DIR at module load — set it first
const stateDir = mkdtempSync(join(tmpdir(), "dw-tags-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

const tags = await import("../lib/tags");

describe("lib/tags", () => {
  it("normalizes: trims, strips '#', dedupes, caps count and length", () => {
    const n = tags.normalizeTags(["  work ", "#urgent", "work", "a  b", "x".repeat(40)]);
    expect(n).toEqual(["work", "urgent", "a b", "x".repeat(24)]);
    expect(tags.normalizeTags(Array.from({ length: 12 }, (_, i) => `t${i}`))).toHaveLength(8);
    expect(tags.normalizeTags("nope")).toBeNull();
    expect(tags.normalizeTags([1])).toBeNull();
    expect(tags.normalizeTags([])).toEqual([]);
  });

  it("persists tags across a module reload (survives restart)", async () => {
    expect(tags.setSessionTags("s1", ["backend", "urgent"])).toEqual(["backend", "urgent"]);
    expect(tags.sessionTags("s1")).toEqual(["backend", "urgent"]);
    expect(tags.allTags()).toEqual({ s1: ["backend", "urgent"] });

    vi.resetModules();
    const fresh = await import("../lib/tags");
    expect(fresh.sessionTags("s1")).toEqual(["backend", "urgent"]);
  });

  it("empty list removes the entry; invalid input rejected", async () => {
    tags.setSessionTags("s2", ["x"]);
    expect(tags.setSessionTags("s2", [])).toEqual([]);
    expect(tags.sessionTags("s2")).toEqual([]);
    expect("s2" in tags.allTags()).toBe(false);
    expect(tags.setSessionTags("s3", "not-an-array")).toBeNull();
  });
});
