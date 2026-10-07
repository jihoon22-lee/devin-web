import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILE_READ, readTextFile } from "../lib/acp/fsRead.mjs";

const dir = mkdtempSync(join(tmpdir(), "dw-fsread-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// 120k numbered lines ≈ 1.4MB — well past the 1MB whole-file cap
const big = join(dir, "big.log");
writeFileSync(big, Array.from({ length: 120_000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");

describe("agent fs reads (M3)", () => {
  it("serves a line range that lies beyond the first MB", async () => {
    expect(await readTextFile(big, 119_998, 2)).toBe("line 119998\nline 119999");
  });

  it("keeps the old split/slice semantics", async () => {
    const f = join(dir, "small.txt");
    writeFileSync(f, "a\r\nb\nc\n");
    expect(await readTextFile(f, 2, 5)).toBe("b\nc\n"); // trailing newline → empty last line
    expect(await readTextFile(f, 1, 1)).toBe("a\r"); // "\r" stays on its line
    expect(await readTextFile(f, undefined, 0)).toBe("");
    expect(await readTextFile(f, 9, 1)).toBe("");
  });

  it("caps a whole-file read at MAX_FILE_READ with a marker", async () => {
    const out = await readTextFile(big);
    expect(out).toContain("…[truncated:");
    expect(Buffer.byteLength(out)).toBeLessThan(MAX_FILE_READ + 200);
  });

  it("never splits a multi-byte character at the cap", async () => {
    const f = join(dir, "kr.txt");
    writeFileSync(f, "가".repeat(400_000)); // 1.2MB of 3-byte chars
    expect((await readTextFile(f)).split("\n")[0]).not.toContain("\uFFFD");
  });

  it("bounds one enormous line inside the range", async () => {
    const f = join(dir, "minified.js");
    writeFileSync(f, "x".repeat(3 * MAX_FILE_READ));
    const out = await readTextFile(f, 1, 1);
    expect(out.length).toBeLessThan(MAX_FILE_READ + 200);
    expect(out).toContain("…[truncated:");
  });
});
