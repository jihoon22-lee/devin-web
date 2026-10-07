import { describe, expect, it } from "vitest";
import { anchorMatch, itemText, findJumpTarget, needsOlderPageForJump } from "../lib/client/jump";
import type { ChatItem } from "../lib/client/model";

describe("itemText", () => {
  it("returns message text and tool output text", () => {
    const text: ChatItem = { id: "a", kind: "text", role: "agent", text: "hello", done: true };
    const tool: ChatItem = {
      id: "b",
      kind: "tool",
      tool: {
        toolCallId: "t",
        content: [{ type: "content", content: { type: "text", text: "npm test passed" } }],
        rawOutput: "exit 0",
      },
    };
    const plan: ChatItem = { id: "c", kind: "plan", entries: [] };
    expect(itemText(text)).toBe("hello");
    expect(itemText(tool)).toBe("npm test passed\nexit 0");
    expect(itemText(plan)).toBe("");
    expect(anchorMatch(itemText(tool), "npm test passed")).toBe(true);
  });
});

describe("findJumpTarget (R12 C2)", () => {
  const t = (id: string, text: string): ChatItem => ({ id, kind: "text", role: "agent", text, done: true });
  const prefix = "Let me check the configuration file before changing anything else here";

  it("matches durable rows by node id even when another row shares the text prefix", () => {
    const items = [t("bf-10", prefix + " A"), t("bf-20", prefix + " B")];
    expect(findJumpTarget(items, { nodeId: 20, anchor: prefix, n: 1 })?.id).toBe("bf-20");
  });

  it("never text-matches a durable row when the node id is absent from the window", () => {
    const items = [t("bf-50", prefix)];
    expect(findJumpTarget(items, { nodeId: 7, anchor: prefix, n: 1 })).toBeUndefined();
  });

  it("falls back to the anchor only for provisional items", () => {
    const items = [t("bf-50", "other"), t("p-t1-0", prefix)];
    expect(findJumpTarget(items, { anchor: prefix, n: 1 })?.id).toBe("p-t1-0");
  });

  it("asks for an older page only when the hit lies above a truncated window", () => {
    const items = [t("bf-50", "x"), t("bf-60", "y")];
    expect(needsOlderPageForJump(items, { nodeId: 7, n: 1 }, true)).toBe(true);
    expect(needsOlderPageForJump(items, { nodeId: 7, n: 1 }, false)).toBe(false);
    expect(needsOlderPageForJump(items, { nodeId: 55, n: 1 }, true)).toBe(false);
    expect(needsOlderPageForJump(items, { anchor: "x", n: 1 }, true)).toBe(false);
  });
});

it("keeps an authoritative old node pending despite a same-prefix provisional message", () => {
  const prefix = "Let me check the configuration file before changing anything else here";
  const items: ChatItem[] = [
    { id: "bf-50", kind: "text", role: "agent", text: "later history", done: true },
    { id: "p-t1-0", kind: "text", role: "agent", text: prefix, done: false },
  ];
  const jump = { nodeId: 7, anchor: prefix, n: 1 };
  expect(findJumpTarget(items, jump)).toBeUndefined();
  expect(needsOlderPageForJump(items, jump, true)).toBe(true);
});
