import { describe, expect, it } from "vitest";
import { mentionPath, mentionUri } from "../lib/acp/mentionUri";

describe("mention URIs (R12 C6)", () => {
  it("round-trips paths with spaces, #, % and Korean", () => {
    for (const p of ["/tmp/dw mention/a #1.txt", "/tmp/100%/x.md", "/tmp/100%20/a?b.txt", "/home/u/문서/메모.txt"]) {
      const uri = mentionUri(p);
      expect(uri.startsWith("file:///")).toBe(true);
      expect(uri).not.toMatch(/[ #]/);
      expect(mentionPath(uri)).toBe(p);
    }
  });

  it("still reads legacy raw file:// URIs persisted in old queues", () => {
    for (const p of ["/tmp/dw mention/a #1.txt", "/tmp/a?b.txt", "/tmp/100%/x.md"])
      expect(mentionPath(`file://${p}`)).toBe(p);
  });
});
