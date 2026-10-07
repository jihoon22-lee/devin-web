import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("source hygiene", () => {
  it("tracked text sources contain no raw control characters", () => {
    const files = execFileSync(
      "git",
      ["ls-files", "*.ts", "*.tsx", "*.mjs", "*.js", "*.css", "*.md", "*.json"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    const bad = files.filter((f) => /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});
