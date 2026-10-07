import { describe, expect, it } from "vitest";
import { serverEpoch } from "../lib/stream/epoch";

describe("serverEpoch", () => {
  it("is a stable per-process id", () => {
    const a = serverEpoch();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(serverEpoch()).toBe(a);
  });
});
