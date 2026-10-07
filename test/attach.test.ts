import { describe, expect, it } from "vitest";
import { decideAttach, type AttachInput } from "../lib/client/attach";

const idle = { active: false, lockedBy: undefined };
const input = (over: Partial<AttachInput>): AttachInput => ({
  listLoaded: true,
  current: idle,
  readOnly: false,
  prior: undefined,
  ...over,
});

describe("decideAttach", () => {
  it("waits until the session list has loaded once", () => {
    expect(decideAttach(input({ listLoaded: false, current: null }))).toBe("wait");
  });
  it("rechecks once, then reports a missing session", () => {
    expect(decideAttach(input({ current: null }))).toBe("recheck");
    expect(decideAttach(input({ current: null, prior: "missing-checked" }))).toBe("missing");
  });
  it("attaches an inactive, unowned session opened by URL", () => {
    expect(decideAttach(input({}))).toBe("attach");
    expect(decideAttach(input({ prior: "missing-checked" }))).toBe("attach");
  });
  it("re-attaches after an earlier success went stale (server/acp restart)", () => {
    expect(decideAttach(input({ prior: "ok" }))).toBe("attach");
  });
  it("does nothing for read-only views, attached sessions, or in-flight/failed attempts", () => {
    expect(decideAttach(input({ readOnly: true }))).toBe("none");
    expect(decideAttach(input({ current: { active: true } }))).toBe("none");
    expect(decideAttach(input({ current: { active: false, lockedBy: { ours: true } } }))).toBe("none");
    expect(decideAttach(input({ prior: "inflight" }))).toBe("none");
    expect(decideAttach(input({ prior: "failed" }))).toBe("none");
  });
});
