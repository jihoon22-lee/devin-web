import { describe, expect, it } from "vitest";
import { attentionDelta, pendingSnapshot } from "../lib/client/attention";

const S = (sessionId: string, pendingRequests?: number) => ({ sessionId, pendingRequests });

describe("attention delta (E3)", () => {
  it("the first poll is a baseline — nothing fires", () => {
    expect(attentionDelta(null, [S("a", 1)], null)).toEqual([]);
  });

  it("fires for sessions whose pending count went up, except the one on screen", () => {
    const prev = pendingSnapshot([S("a", 0), S("b", 1), S("c", 0)]);
    const next = [S("a", 1), S("b", 1), S("c", 2), S("d", 1)];
    expect(attentionDelta(prev, next, "c").map((s) => s.sessionId)).toEqual(["a", "d"]);
  });

  it("answering a card (count going down) is silent", () => {
    expect(attentionDelta(pendingSnapshot([S("a", 2)]), [S("a", 1)], null)).toEqual([]);
  });
});
