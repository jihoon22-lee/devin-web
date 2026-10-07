import { describe, expect, it } from "vitest";
import { annotateHunks, wordDiff } from "../lib/client/wordDiff";

describe("wordDiff", () => {
  it("marks only the changed words", () => {
    const { a, b } = wordDiff("const timeout = 30;", "const timeout = 60;");
    expect(a.filter((s) => s.changed).map((s) => s.text)).toEqual(["30"]);
    expect(b.filter((s) => s.changed).map((s) => s.text)).toEqual(["60"]);
    expect(b.map((s) => s.text).join("")).toBe("const timeout = 60;");
  });
  it("handles Korean words", () => {
    const { b } = wordDiff("세션을 불러옵니다", "세션을 다시 불러옵니다");
    expect(b.filter((s) => s.changed).map((s) => s.text.trim())).toEqual(["다시"]);
  });
});

describe("annotateHunks", () => {
  it("numbers lines from the hunk header and pairs del/add runs", () => {
    const out = annotateHunks(["@@ -10,3 +10,3 @@ fn", " keep", "-old line", "+new line", " tail"]);
    expect(out.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ["hunk", undefined, undefined], ["ctx", 10, 10], ["del", 11, undefined], ["add", undefined, 11], ["ctx", 12, 12],
    ]);
    expect(out[3].segs?.find((s) => s.changed)?.text).toBe("new");
  });
});
