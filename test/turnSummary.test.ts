import { describe, expect, it } from "vitest";
import { fmtDuration, turnSummaries } from "../lib/client/turnSummary";
import type { ChatItem } from "../lib/client/model";

const user = (id: string, ts: number): ChatItem => ({ id, kind: "text", role: "user", text: "q", done: true, ts });
const agent = (id: string, ts?: number): ChatItem => ({ id, kind: "text", role: "agent", text: "a", done: true, ts });
const tool = (id: string, kind: string, ts: number): ChatItem =>
  ({ id, kind: "tool", tool: { toolCallId: id, kind, status: "completed" }, ts }) as ChatItem;

describe("turnSummaries", () => {
  const items = [
    user("bf-1", 1000), tool("bf-2", "edit", 5000), tool("bf-3", "execute", 9000), agent("bf-4", 61000),
    user("bf-5", 70000), agent("bf-6", 71000),
    user("bf-7", 80000), tool("bf-8", "read", 90000), agent("bf-9", 95000),
  ];
  it("summarizes each finished turn at its last item", () => {
    const m = turnSummaries(items, true);
    expect(m.get("bf-4")).toEqual({ ms: 60000, tools: 2, edits: 1 });
    expect(m.has("bf-6")).toBe(false); // trivial Q&A — no footer
    expect(m.get("bf-9")).toEqual({ ms: 15000, tools: 1, edits: 0 });
  });
  it("skips the trailing turn while it runs and live turns entirely", () => {
    expect(turnSummaries(items, false).has("bf-9")).toBe(false);
    const live = [user("p-t-1", 1), tool("p-t-2", "edit", 2), agent("p-t-3")];
    expect(turnSummaries(live, true).size).toBe(0);
  });
  it("formats durations", () => {
    expect(fmtDuration(4200)).toBe("4s");
    expect(fmtDuration(134000)).toBe("2m 14s");
    expect(fmtDuration(3_900_000)).toBe("1h 5m");
  });
});
