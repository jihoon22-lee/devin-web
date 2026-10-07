import { describe, expect, it } from "vitest";
import { foldContext, lineDiff } from "../lib/diff";

describe("lineDiff", () => {
  it("marks added and removed lines", () => {
    const rows = lineDiff("a\nb\nc", "a\nx\nc");
    expect(rows.map((r) => r.type)).toEqual(["same", "del", "add", "same"]);
    expect(rows[1].text).toBe("b");
    expect(rows[2].text).toBe("x");
  });

  it("treats null oldText as all-added", () => {
    const rows = lineDiff(null, "a\nb");
    expect(rows.every((r) => r.type === "add")).toBe(true);
  });

  it("keeps identical files all-same", () => {
    const rows = lineDiff("a\nb", "a\nb");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === "same")).toBe(true);
  });

  it("falls back on a huge asymmetric input (300k lines vs 5)", () => {
    // the product guard alone let this through — 300k × 5 = 1.5M < 2.25M,
    // yet the dp matrix would still be enormous
    const huge = Array.from({ length: 300_000 }, (_, i) => `line${i}`).join("\n");
    const rows = lineDiff(huge, "a\nb\nc\nd\ne");
    expect(rows.filter((r) => r.type === "del")).toHaveLength(300_000);
    expect(rows.filter((r) => r.type === "add")).toHaveLength(5);
    expect(rows.some((r) => r.type === "same")).toBe(false);
  });
});

describe("foldContext", () => {
  it("folds a long unchanged run in the middle", () => {
    const rows = lineDiff(
      ["top-old", ...Array.from({ length: 20 }, (_, i) => `u${i}`), "tail-old"].join("\n"),
      ["top-new", ...Array.from({ length: 20 }, (_, i) => `u${i}`), "tail-new"].join("\n"),
    );
    const folded = foldContext(rows, 3);
    expect(folded.some((r) => r.type === "fold")).toBe(true);
    const fold = folded.find((r) => r.type === "fold")!;
    expect(fold.folded).toBe(20 - 6);
    expect(folded.some((r) => r.type === "del" && r.text === "tail-old")).toBe(true);
    expect(folded.some((r) => r.type === "add" && r.text === "tail-new")).toBe(true);
  });

  it("does not fold short runs", () => {
    const rows = lineDiff("a\nx\nb", "a\ny\nb");
    const folded = foldContext(rows, 3);
    expect(folded.every((r) => r.type !== "fold")).toBe(true);
  });
});
