import { describe, expect, it } from "vitest";
import { parseAuthed, parseDevinVersion } from "../lib/devinCli";

describe("devin CLI probes", () => {
  it("parses the version line", () => {
    expect(parseDevinVersion("devin 3000.10.31 (abcdef12)\n")).toBe("3000.10.31");
    expect(parseDevinVersion("command not found")).toBeNull();
  });

  it("reads the login state", () => {
    expect(parseAuthed(0, "Logged in (via Devin).\n\nCredentials:")).toBe(true);
    expect(parseAuthed(0, "Not logged in")).toBe(false);
    expect(parseAuthed(1, "Logged in")).toBe(false);
  });
});
