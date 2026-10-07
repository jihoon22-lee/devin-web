import { describe, expect, it } from "vitest";
import { groupToolRuns, indexToolRuns, toolName, toolRunSummary } from "../lib/client/toolRuns";
import type { ChatItem } from "../lib/client/model";

const tool = (id: string, over: Record<string, unknown> = {}): ChatItem => ({
  id,
  kind: "tool",
  tool: { toolCallId: id, title: `call ${id}`, status: "completed", ...over },
});
const text = (id: string): ChatItem => ({ id, kind: "text", role: "agent", text: id, done: true });

describe("groupToolRuns", () => {
  it("groups runs of ≥3 consecutive tool items, preserving order", () => {
    const rows = groupToolRuns([
      text("t1"),
      tool("a1"), tool("a2"), tool("a3"), tool("a4"),
      text("t2"),
      tool("b1"), tool("b2"), // below the threshold — stays inline
      text("t3"), // breaks b's run from c's — consecutive runs would merge
      tool("c1"), tool("c2"), tool("c3"),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["item", "group", "item", "item", "item", "item", "group"]);
    const g1 = rows[1];
    if (g1.type !== "group") throw new Error("expected group");
    expect(g1.items.map((i) => i.id)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(g1.id).toBe("tg-a1");
  });

  it("a single interruption breaks the run", () => {
    const rows = groupToolRuns([tool("a1"), tool("a2"), text("t"), tool("a3"), tool("a4")]);
    expect(rows.every((r) => r.type === "item")).toBe(true);
  });

  it("indexToolRuns maps member ids to their group id", () => {
    const rows = groupToolRuns([tool("a1"), tool("a2"), tool("a3"), text("t")]);
    const idx = indexToolRuns(rows);
    expect(idx.get("a2")).toBe("tg-a1");
    expect(idx.has("t")).toBe(false);
  });
});

describe("toolRunSummary", () => {
  const items = [
    tool("a1", { status: "completed" }),
    tool("a2", { status: "in_progress" }),
    tool("a3", { status: "failed" }),
    tool("a4", { status: "failed" }),
  ] as Extract<ChatItem, { kind: "tool" }>[];

  it("counts failures and flags an in-progress run as active", () => {
    const s = toolRunSummary(items);
    expect(s.count).toBe(4);
    expect(s.failures).toBe(2);
    expect(s.active).toBe(true);
  });

  it("names by inferenceToolName when present, else the kind bucket", () => {
    expect(
      toolName({
        toolCallId: "x",
        status: "completed",
        _meta: { "cognition.ai/inferenceToolName": "todo_write" },
      } as never),
    ).toBe("todo_write");
    expect(toolName({ toolCallId: "x", status: "completed", kind: "edit" } as never)).toBe("edit");
    expect(toolName({ toolCallId: "x", status: "completed" } as never)).toBe("tool");
  });
});

import { parseGitDiff } from "../lib/client/diffParse";

describe("parseGitDiff", () => {
  const PATCH = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index abc123..def456 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " ctx",
    "-old",
    "+new",
    "diff --git a/new.ts b/new.ts",
    "new file mode 100644",
    "index 000..111",
    "--- /dev/null",
    "+++ b/new.ts",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "@@ -1 +0,0 @@",
    "-bye",
    "",
  ].join("\n");

  it("splits per file, keeps hunks, strips the envelope", () => {
    const files = parseGitDiff(PATCH);
    expect(files).toHaveLength(3);
    expect(files[0].path).toBe("src/a.ts");
    expect(files[0].lines).toEqual(["@@ -1,3 +1,4 @@", " ctx", "-old", "+new"]);
    expect(files[1]).toMatchObject({ path: "new.ts", isNew: true });
    expect(files[2]).toMatchObject({ path: "gone.ts", isDeleted: true });
  });

  it("returns no blocks for empty input", () => {
    expect(parseGitDiff("")).toEqual([]);
    expect(parseGitDiff("\n\n")).toEqual([]);
  });
});
