import { describe, expect, it } from "vitest";
import { alignSpine, computeAnchors } from "../lib/acp/alignSpine";
import type { AssembledItem } from "../lib/acp/itemAssembler";

const item = (id: string, extra: Partial<AssembledItem> = {}): AssembledItem => ({
  id,
  kind: "text",
  role: "agent",
  text: `text-${id}`,
  done: true,
  seqFrom: 1,
  seqTo: 1,
  ...extra,
});

const thought = (id: string) => item(id, { role: "thought" });
const plan = (id: string) => item(id, { kind: "plan", role: undefined });
const tool = (id: string, tc: string) =>
  item(id, { kind: "tool", role: undefined, tool: { toolCallId: tc, title: "t", status: "completed" } });

const row = (nodeId: number, role: "user" | "agent" | "tool", toolCallId?: string) =>
  ({ nodeId, role, toolCallId });

describe("alignSpine", () => {
  it("aligns tools by toolCallId and texts by role order — monotonic", () => {
    const prov = [
      item("p-t-0", { role: "user" }),
      thought("p-t-1"),
      item("p-t-2"),
      tool("p-t-3", "tc1"),
      thought("p-t-4"),
      item("p-t-5"),
    ];
    const rows = [
      row(10, "user"),
      row(11, "agent"),
      row(12, "tool", "tc1"),
      row(13, "agent"),
    ];
    const m = alignSpine(prov, rows);
    expect(m.get("p-t-0")).toBe(10);
    expect(m.get("p-t-2")).toBe(11);
    expect(m.get("p-t-3")).toBe(12);
    expect(m.get("p-t-5")).toBe(13);
    // non-spine items never appear in the map
    expect(m.has("p-t-1")).toBe(false);
    expect(m.has("p-t-4")).toBe(false);
  });

  it("toolCallId match is exact — a different id does not steal the row", () => {
    const prov = [tool("p-t-0", "tc-A"), tool("p-t-1", "tc-B")];
    const rows = [row(5, "tool", "tc-B"), row(6, "tool", "tc-A")];
    const m = alignSpine(prov, rows);
    // cursor is monotonic: tc-A matches row 6, tc-B can never reach row 5
    expect(m.get("p-t-0")).toBe(6);
    expect(m.has("p-t-1")).toBe(false);
  });

  it("extra durable rows are skipped; missing durable rows leave spine unaligned", () => {
    const prov = [item("p-t-0"), item("p-t-1")];
    // the CLI merged the two agent chunks into one assistant row
    const m = alignSpine(prov, [row(20, "user"), row(21, "agent")]);
    expect(m.get("p-t-0")).toBe(21);
    expect(m.has("p-t-1")).toBe(false);
  });
});

describe("computeAnchors", () => {
  it("anchors each retained item to the last aligned spine row before it", () => {
    const prov = [
      thought("p-t-0"),              // before any spine → turnStartNode
      item("p-t-1"),                 // → 11
      tool("p-t-2", "tc"),           // → 12
      thought("p-t-3"),              // → 12
      plan("p-t-4"),                 // → 12
      item("p-t-5"),                 // unaligned (no 3rd agent row)
      thought("p-t-6"),              // → 12 (last ALIGNED spine, not p-t-5)
    ];
    const rows = [row(10, "user"), row(11, "agent"), row(12, "tool", "tc")];
    const { anchors, violations } = computeAnchors(prov, rows, 10, 12);
    expect(anchors.get("p-t-0")).toBe(10);
    expect(anchors.get("p-t-3")).toBe(12);
    expect(anchors.get("p-t-4")).toBe(12);
    expect(anchors.get("p-t-6")).toBe(12);
    expect(violations).toEqual([]);
    // spine and non-retained kinds never get anchors
    expect(anchors.has("p-t-1")).toBe(false);
    expect(anchors.has("p-t-5")).toBe(false);
  });

  it("no durable rows at all — every retained item anchors to turnStartNode", () => {
    const prov = [thought("p-t-0"), item("p-t-1"), plan("p-t-2")];
    const { anchors } = computeAnchors(prov, [], 7, 7);
    expect(anchors.get("p-t-0")).toBe(7);
    expect(anchors.get("p-t-2")).toBe(7);
  });

  it("clamps out-of-turn anchors to turnStartNode and reports them", () => {
    // pathological: a spine row beyond turnEndNode must never produce a
    // tail-clump anchor — clamp + report so the server beacon fires
    const prov = [item("p-t-0"), thought("p-t-1")];
    const { anchors, violations } = computeAnchors(prov, [row(99, "agent")], 10, 20);
    expect(anchors.get("p-t-1")).toBe(10);
    expect(violations).toEqual(["p-t-1"]);
  });

  it("request and notice items are never retained", () => {
    const prov = [
      item("p-t-0"),
      item("p-t-1", { kind: "request", role: undefined, requestId: "r1", method: "m", params: {} }),
      item("p-t-2", { kind: "notice", role: undefined }),
    ];
    const { anchors } = computeAnchors(prov, [row(11, "agent")], 10, 11);
    expect(anchors.size).toBe(0);
  });
});
