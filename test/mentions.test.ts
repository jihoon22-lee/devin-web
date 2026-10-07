import { describe, expect, it } from "vitest";
import { activeMentionQuery, relMentionPath } from "../lib/mentions";

describe("activeMentionQuery", () => {
  it("returns query after @ at word boundary", () => {
    expect(activeMentionQuery("look at @src/fo", 15)).toEqual({ q: "src/fo", start: 9 });
  });
  it("returns null mid-token", () => {
    expect(activeMentionQuery("email a@b.com", 12)).toBeNull();
  });
  it("returns null without @", () => {
    expect(activeMentionQuery("hello", 5)).toBeNull();
  });
  it("allows @ at start", () => {
    expect(activeMentionQuery("@re", 3)).toEqual({ q: "re", start: 1 });
  });
});

describe("relMentionPath", () => {
  it("strips the cwd prefix", () => {
    expect(relMentionPath("/tmp/x", "/tmp/x/src/f.ts")).toBe("src/f.ts");
  });
  it("ignores a single trailing slash on cwd", () => {
    expect(relMentionPath("/tmp/x/", "/tmp/x/src/f.ts")).toBe("src/f.ts");
  });
  it("does not match a sibling that shares a string prefix", () => {
    expect(relMentionPath("/tmp/x", "/tmp/x2/f")).toBe("/tmp/x2/f");
    expect(relMentionPath("/tmp/x/", "/tmp/x2/f")).toBe("/tmp/x2/f");
  });
  it("passes through non-prefix paths unchanged", () => {
    expect(relMentionPath("/tmp/x", "/elsewhere/f")).toBe("/elsewhere/f");
    expect(relMentionPath("/tmp/x", "rel/f")).toBe("rel/f");
  });
  it("treats cwd '/' as a boundary, not a strip", () => {
    expect(relMentionPath("/", "/etc/hosts")).toBe("/etc/hosts");
  });
});
