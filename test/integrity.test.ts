import { describe, expect, it } from "vitest";
import { checkIntegrity, integrityBeacon } from "../lib/client/integrity";
import { emptySessionState, applyDurableSnapshot, type ChatItem } from "../lib/client/model";

const text = (id: string, t: string, seqFrom?: number): ChatItem =>
  ({ id, kind: "text", role: "agent", text: t, done: true, seqFrom });

describe("checkIntegrity", () => {
  it("flags two items sharing a long prefix", () => {
    const long = "A".repeat(60) + "structural duplicate marker " + "B".repeat(60);
    const r = checkIntegrity([text("bf-1", long), text("ev-9", long)]);
    expect(r.dupes).toHaveLength(1);
    expect(r.dupes[0]).toMatchObject({ a: "bf-1", b: "ev-9" });
    expect(r.dupes[0].chars).toBeGreaterThanOrEqual(100);
  });

  it("ignores short or distinct items", () => {
    expect(checkIntegrity([text("a", "ok"), text("b", "ok")]).dupes).toEqual([]);
    expect(
      checkIntegrity([text("a", "x".repeat(200)), text("b", "y".repeat(200))]).dupes,
    ).toEqual([]);
  });

  it("flags live seq going backwards between items", () => {
    const r = checkIntegrity([text("ev-5", "first", 5), text("ev-3", "second", 3)]);
    expect(r.disorder).toHaveLength(1);
    expect(r.disorder[0]).toMatchObject({ id: "ev-3", prev: 5, cur: 3 });
  });

  it("does not flag durable rows interleaved with live items", () => {
    // bf- rows carry no seqFrom — they must not participate in the seq check
    const r = checkIntegrity([
      text("ev-5", "a", 5),
      text("bf-70", "b"),
      text("ev-7", "c", 7),
    ]);
    expect(r.disorder).toEqual([]);
  });

  it("a durable ++ provisional render stays clean across the seam", () => {
    // the two-region render puts the assembled turn after durable rows —
    // thought/plan items there are by design, not a clump signature
    const long = "durable row text " + "x".repeat(120);
    const r = checkIntegrity([
      text("bf-1", long),
      text("bf-2", "durable two"),
      text("p-t1-0", "thinking", 5),
      { id: "p-t1-1", kind: "plan", entries: [], seqFrom: 6 } as ChatItem,
      text("p-t1-2", "answer", 7),
    ]);
    expect(r.dupes).toEqual([]);
    expect(r.disorder).toEqual([]);
  });
});


describe("integrityBeacon (D V2-3)", () => {
  it("is null for a clean state and signs a duplicate", () => {
    const st = emptySessionState();
    expect(integrityBeacon(st, "S")).toBeNull();
    const long = "same text ".repeat(20);
    applyDurableSnapshot(st, [{ id: 1, role: "assistant", text: long, ts: 1 }, { id: 2, role: "assistant", text: long, ts: 2 }]);
    const b = integrityBeacon(st, "S")!;
    expect(b.sig).toMatch(/^1:/);
    expect(b.body).toMatchObject({ s: "S", dupes: [{ a: "bf-1", b: "bf-2" }] });
  });
});


it("integrityBeacon reports watermark and orphan alarms without consuming state", () => {
  const st = emptySessionState();
  applyDurableSnapshot(st, [{ id: 1, role: "assistant", text: "row", ts: 1 }]);
  st.retained = [{ ...text("thought", "thinking"), anchor: 2 }];
  st.sunkLive = { pushed: 2, inserted: 1, at: 1 };
  const beacon = integrityBeacon(st, "S");
  expect(beacon?.body).toMatchObject({ s: "S", orphanAnchor: 1, sunkLive: { pushed: 2, inserted: 1 } });
  expect(st.sunkLive).toEqual({ pushed: 2, inserted: 1, at: 1 });
  st.durable = [];
  st.sunkLive = undefined;
  expect(integrityBeacon(st, null)).toBeNull();
});
