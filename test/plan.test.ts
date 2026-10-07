import { describe, expect, it } from "vitest";
import {
  diffPlan,
  entriesEqual,
  formatRel,
  planProgress,
  planSnapshots,
  todoEntries,
} from "../lib/client/plan";
import type { ChatItem } from "../lib/client/model";
import type { PlanEntry, ToolCallUpdate } from "../lib/acp/types";

const todoTool = (todos: unknown, extra: Partial<ToolCallUpdate> = {}): ToolCallUpdate => ({
  toolCallId: "tc1",
  title: "todo_write",
  status: "completed",
  rawInput: { todos },
  _meta: { "cognition.ai/inferenceToolName": "todo_write" },
  ...extra,
});

const toolItem = (id: string, tool: ToolCallUpdate, ts?: number): ChatItem => ({
  id,
  kind: "tool",
  tool,
  ts,
});

const planItem = (
  id: string,
  entries: PlanEntry[],
  extra: Partial<Extract<ChatItem, { kind: "plan" }>> = {},
): ChatItem => ({ id, kind: "plan", entries, ...extra });

const E = (content: string, status?: string): PlanEntry => ({ content, status });

describe("todoEntries", () => {
  it("parses a todo_write tool call into PlanEntry[]", () => {
    expect(
      todoEntries(todoTool([{ content: "a", status: "in_progress", priority: "high" }])),
    ).toEqual([{ content: "a", status: "in_progress", priority: "high" }]);
  });

  it("rejects a non-todo tool", () => {
    expect(
      todoEntries({
        toolCallId: "t",
        _meta: { "cognition.ai/inferenceToolName": "edit" },
        rawInput: { todos: [{ content: "a" }] },
      }),
    ).toBeNull();
    expect(todoEntries({ toolCallId: "t", rawInput: { todos: [] } })).toBeNull();
    expect(todoEntries(undefined)).toBeNull();
  });

  it("rejects malformed todos payloads", () => {
    expect(todoEntries(todoTool("nope"))).toBeNull(); // todos not an array
    expect(todoEntries(todoTool([{ content: 1 }]))).toBeNull(); // non-string content
    expect(todoEntries(todoTool(["a"]))).toBeNull(); // non-object entry
    const noInput = todoTool(undefined);
    delete (noInput as { rawInput?: unknown }).rawInput;
    expect(todoEntries(noInput)).toBeNull();
    // a null prototype guard: _meta present but wrong type
    expect(
      todoEntries({ toolCallId: "t", _meta: null, rawInput: { todos: [] } }),
    ).toBeNull();
  });
});

describe("entriesEqual", () => {
  it("compares content, status and priority per entry", () => {
    expect(entriesEqual([E("a", "pending")], [E("a", "pending")])).toBe(true);
    expect(entriesEqual([E("a", "pending")], [E("a", "completed")])).toBe(false);
    expect(entriesEqual([E("a")], [E("a"), E("b")])).toBe(false);
    expect(
      entriesEqual([{ content: "a", priority: "high" }], [{ content: "a", priority: "low" }]),
    ).toBe(false);
  });
});

describe("planSnapshots", () => {
  it("walks render order and stamps todo snapshots with ts/nodeId", () => {
    const items: ChatItem[] = [
      toolItem("bf-7", todoTool([E("a", "pending")]), 1_700_000_000_000),
      planItem("p-t-0", [E("x")]),
    ];
    const snaps = planSnapshots(items);
    expect(snaps.map((s) => s.source)).toEqual(["todo", "live"]);
    expect(snaps[0]).toMatchObject({ itemId: "bf-7", ts: 1_700_000_000_000, nodeId: 7 });
    expect(snaps[1]).toMatchObject({ key: "p:p-t-0", itemId: "p-t-0" });
  });

  it("expands a provisional plan card's revisions into one snapshot each", () => {
    const items: ChatItem[] = [
      planItem("p-t-1", [E("a", "completed"), E("b", "in_progress")], {
        revisions: [
          { seq: 1, ts: 100, entries: [E("a", "in_progress"), E("b", "pending")] },
          { seq: 2, ts: 200, entries: [E("a", "completed"), E("b", "in_progress")] },
        ],
      }),
    ];
    const snaps = planSnapshots(items);
    expect(snaps).toHaveLength(2);
    expect(snaps[0]).toMatchObject({ key: "p-t-1#r0", source: "live", ts: 100 });
    expect(snaps[1]).toMatchObject({ key: "p-t-1#r1", source: "live", ts: 200 });
  });

  it("collapses consecutive snapshots with identical entries", () => {
    const same = [E("a", "pending")];
    const items: ChatItem[] = [
      toolItem("bf-1", todoTool(same)),
      toolItem("bf-2", todoTool(same)),
      toolItem("bf-3", todoTool([E("a", "completed")])),
    ];
    const snaps = planSnapshots(items);
    expect(snaps.map((s) => s.itemId)).toEqual(["bf-1", "bf-3"]);
  });

  it("includes retained/durable cards only when no todo snapshot exists", () => {
    const retained = planItem("p-old-0", [E("a", "completed")], { anchor: 5 });
    const only = planSnapshots([retained]);
    expect(only.map((s) => s.source)).toEqual(["card"]);

    const withTodo = planSnapshots([
      retained,
      toolItem("bf-9", todoTool([E("b", "pending")])),
    ]);
    expect(withTodo.map((s) => s.source)).toEqual(["todo"]);
  });
});

describe("diffPlan", () => {
  it("treats a null previous plan as all-added", () => {
    expect(diffPlan(null, [E("a"), E("b")])).toEqual({
      completed: [],
      started: [],
      added: ["a", "b"],
      removed: [],
    });
  });

  it("reports status transitions by entry content", () => {
    const prev = [E("a", "in_progress"), E("b", "pending"), E("c", "pending")];
    const next = [E("a", "completed"), E("b", "in_progress"), E("d", "pending")];
    expect(diffPlan(prev, next)).toEqual({
      completed: ["a"],
      started: ["b"],
      added: ["d"],
      removed: ["c"],
    });
  });

  it("ignores unchanged entries", () => {
    const prev = [E("a", "completed")];
    expect(diffPlan(prev, [E("a", "completed")])).toEqual({
      completed: [],
      started: [],
      added: [],
      removed: [],
    });
  });
});

describe("planProgress", () => {
  it("counts completed and finds the first in_progress entry", () => {
    const entries = [E("a", "completed"), E("b", "in_progress"), E("c", "pending")];
    expect(planProgress(entries)).toEqual({ done: 1, total: 3, current: E("b", "in_progress") });
    expect(planProgress([E("a", "failed")]).current).toBeUndefined();
  });
});

describe("formatRel", () => {
  it("formats seconds, minutes and hours ago", () => {
    const now = 100_000_000;
    expect(formatRel(now - 12_000, now)).toBe("12s ago");
    expect(formatRel(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRel(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRel(undefined, now)).toBe("");
  });
});
