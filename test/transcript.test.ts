import { describe, expect, it } from "vitest";
import { orderMainChain, rowsToTranscript, rowToItem, type MessageNodeRow } from "../lib/transcript";

const row = (id: number, parent: number | null, msg: unknown): MessageNodeRow => ({
  node_id: id,
  parent_node_id: parent,
  chat_message: typeof msg === "string" ? msg : JSON.stringify(msg),
  created_at: id,
});

describe("orderMainChain", () => {
  it("follows parent links back from the newest node", () => {
    const rows = [
      row(1, null, { role: "user", content: "a" }),
      row(2, 1, { role: "assistant", content: "b" }),
      row(3, 1, { role: "assistant", content: "fork branch" }), // fork off node 1
      row(4, 2, { role: "user", content: "c" }),
    ];
    const chain = orderMainChain(rows);
    expect(chain.map((r) => r.node_id)).toEqual([1, 2, 4]); // newest=4 → 2 → 1
  });
});

describe("rowsToTranscript", () => {
  it("maps roles, joins text blocks, skips system/empty", () => {
    const rows = [
      row(1, null, { role: "system", content: "sys prompt" }),
      row(2, 1, { role: "user", content: [{ type: "text", text: "hi" }] }),
      row(3, 2, {
        role: "assistant",
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "there" },
        ],
      }),
      row(4, 3, { role: "tool", content: [{ type: "tool_result", text: "" }], metadata: { tool_name: "bash" } }),
    ];
    const { items, truncated } = rowsToTranscript(rows);
    expect(truncated).toBe(false);
    expect(items.map((i) => i.role)).toEqual(["user", "assistant", "tool"]);
    expect(items[1].text).toBe("hello \nthere");
    expect(items[2].toolName).toBe("bash");
  });

  it("drops internal user nodes (is_user_input falsy), keeps real input", () => {
    // CLI marks genuine prompts metadata.is_user_input=1 — compaction/
    // summary payloads are user-role nodes with the key present but falsy,
    // and they carry the ENTIRE conversation (observed: a 174KB node
    // rendering as a giant user bubble duplicating the whole transcript)
    const rows = [
      row(1, null, { role: "user", content: "real prompt", metadata: { is_user_input: 1 } }),
      row(2, 1, {
        role: "user",
        content: "Conversation to summarize: === MESSAGE 0 === ...",
        metadata: { is_user_input: null },
      }),
      row(3, 2, { role: "user", content: "no metadata at all", }),
      row(4, 3, { role: "assistant", content: "answer" }),
    ];
    const { items } = rowsToTranscript(rows);
    expect(items.map((i) => i.role)).toEqual(["user", "user", "assistant"]);
    expect(items[0].text).toBe("real prompt");
    expect(items[1].text).toBe("no metadata at all");
  });

  it("rowToItem drops internal user nodes too", () => {
    expect(
      rowToItem(row(1, null, { role: "user", content: "x", metadata: { is_user_input: 0 } })),
    ).toBeNull();
    expect(
      rowToItem(row(2, null, { role: "user", content: "y", metadata: { is_user_input: true } })),
    ).not.toBeNull();
  });

  it("caps at max and marks truncated", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row(i + 1, i || null, { role: "user", content: `m${i}` }),
    );
    const { items, truncated } = rowsToTranscript(rows, 3);
    expect(truncated).toBe(true);
    expect(items.length).toBe(3);
    expect(items[0].text).toBe("m7"); // keeps the newest tail
  });
});
