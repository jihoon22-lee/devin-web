// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import FindSheet, { findInItems, mergeOutline } from "../components/FindSheet";
import type { ChatItem } from "../lib/client/model";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const items: ChatItem[] = [
  { id: "bf-1", kind: "text", role: "user", text: "Fix the login bug", done: true, ts: 1 },
  { id: "bf-2", kind: "text", role: "agent", text: "The LOGIN handler drops the cookie", done: true },
  { id: "bf-3", kind: "tool", tool: { toolCallId: "t", title: "grep login", content: [{ type: "content", content: { type: "text", text: "src/login.ts:3" } }] } } as ChatItem,
  { id: "bf-4", kind: "text", role: "user", text: "Now add tests", done: true },
];

describe("findInItems", () => {
  it("lists the user's prompts as the outline when empty", () => {
    expect(findInItems(items, "").map((h) => h.id)).toEqual(["bf-1", "bf-4"]);
  });
  it("matches case-insensitively across messages and tool output", () => {
    expect(findInItems(items, "login").map((h) => [h.id, h.kind])).toEqual([
      ["bf-1", "user"], ["bf-2", "agent"], ["bf-3", "tool"],
    ]);
  });
});

describe("mergeOutline", () => {
  it("lists every server prompt, then live prompts it doesn't have yet", () => {
    const live: ChatItem = { id: "p-t-1", kind: "text", role: "user", text: "live one", done: true };
    const out = mergeOutline([...items, live], [
      { nodeId: 0, text: "very first prompt" },
      { nodeId: 1, text: "Fix the login bug" },
      { nodeId: 4, text: "Now add tests" },
    ]);
    expect(out.map((h) => h.id)).toEqual(["bf-0", "bf-1", "bf-4", "p-t-1"]);
    expect(out[0].nodeId).toBe(0);
  });
  it("falls back to loaded prompts without a server list", () => {
    expect(mergeOutline(items, null).map((h) => h.id)).toEqual(["bf-1", "bf-4"]);
  });
});

describe("FindSheet", () => {
  it("jumps to a picked prompt and closes", async () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      render(<FindSheet items={items} canLoadOlder={false} loadingOlder={false} onLoadOlder={() => {}} onJump={onJump} onClose={onClose} />);
    });
    expect(screen.getByText("Your prompts (2)")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Find in this session…"), { target: { value: "cookie" } });
    fireEvent.click(screen.getByText("cookie"));
    expect(onJump).toHaveBeenCalledWith("bf-2");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("FindSheet outline jumps", () => {
  it("pages history in for a prompt that isn't loaded", async () => {
    const onJump = vi.fn();
    const onJumpNode = vi.fn();
    await act(async () => {
      render(
        <FindSheet
          items={items}
          canLoadOlder
          loadingOlder={false}
          onLoadOlder={() => {}}
          onJump={onJump}
          onJumpNode={onJumpNode}
          onClose={() => {}}
        />,
      );
    });
    // no sessionId → local outline; a loaded prompt jumps directly
    fireEvent.click(screen.getByText("Now add tests"));
    expect(onJump).toHaveBeenCalledWith("bf-4");
    expect(onJumpNode).not.toHaveBeenCalled();
  });
});
