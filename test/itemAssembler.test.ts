// test/itemAssembler.test.ts
import { describe, expect, it } from "vitest";
import { ItemAssembler, PLAN_REVISIONS_MAX, itemRev } from "../lib/acp/itemAssembler";

const upd = (seq: number, data: Record<string, unknown>) =>
  ({ seq, type: "session_update", data });

describe("ItemAssembler", () => {
  it("merges consecutive same-role chunks into one item with a seq range", () => {
    const a = new ItemAssembler("t1");
    a.push(upd(1, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "he" } }));
    a.push(upd(2, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "llo" } }));
    const items = a.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "text", role: "agent", text: "hello", seqFrom: 1, seqTo: 2 });
  });

  it("list() is a snapshot — later pushes must not mutate a held array", () => {
    const a = new ItemAssembler("t1");
    a.push(upd(1, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" } }));
    const snap = a.list();
    a.push(upd(2, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "two" } }));
    expect(snap).toHaveLength(1);
    expect(a.list()).toHaveLength(2);
  });

  it("starts a new item when the role changes and keeps ids stable", () => {
    const a = new ItemAssembler("t1");
    a.push(upd(1, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }));
    a.push(upd(2, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "t" } }));
    a.push(upd(3, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "y" } }));
    const ids = a.list().map((i) => i.id);
    expect(a.list().map((i) => i.role)).toEqual(["agent", "thought", "agent"]);
    expect(new Set(ids).size).toBe(3);
    // pushing more into the last item must not change its id
    a.push(upd(4, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "z" } }));
    expect(a.list()[2].id).toBe(ids[2]);
    expect(a.list()[2].text).toBe("yz");
  });

  it("keys tool cards by toolCallId and never regresses status", () => {
    const a = new ItemAssembler("t1");
    a.push(upd(1, { sessionUpdate: "tool_call", toolCallId: "c1", title: "Ran x", status: "in_progress" }));
    a.push(upd(2, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" }));
    a.push(upd(3, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" }));
    const tools = a.list().filter((i) => i.kind === "tool");
    expect(tools).toHaveLength(1);
    expect((tools[0].tool as { status: string }).status).toBe("completed");
  });

  it("closeAll marks every open item done", () => {
    const a = new ItemAssembler("t1");
    a.push(upd(1, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }));
    a.push(upd(2, { sessionUpdate: "tool_call", toolCallId: "c1", title: "t", status: "in_progress" }));
    a.closeAll();
    expect(a.list().every((i) => i.done)).toBe(true);
  });

  it("is deterministic — the same event sequence yields identical output", () => {
    const evs = [
      upd(1, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } }),
      upd(2, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "b" } }),
      upd(3, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "c" } }),
    ];
    const run = () => { const a = new ItemAssembler("t1"); for (const e of evs) a.push(e); return a.list(); };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe("plan revisions", () => {
  const plan = (seq: number, entries: { content: string; status?: string; priority?: string }[], ts?: number) =>
    ({ seq, ts, type: "session_update", data: { sessionUpdate: "plan", entries } });

  it("accumulates seq/ts/entries on each distinct update", () => {
    const a = new ItemAssembler("t1");
    a.push(plan(1, [{ content: "one", status: "pending" }], 1000));
    a.push(plan(2, [{ content: "one", status: "in_progress" }], 2000));
    a.push(plan(3, [{ content: "one", status: "completed" }, { content: "two", status: "pending" }], 3000));
    const p = a.list()[0];
    expect(p.revisions?.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(p.revisions?.map((r) => r.ts)).toEqual([1000, 2000, 3000]);
    expect(p.revisions?.[2].entries).toHaveLength(2);
    expect(p.entries).toEqual([
      { content: "one", status: "completed" },
      { content: "two", status: "pending" },
    ]);
  });

  it("a re-sent identical snapshot updates in place without a new revision", () => {
    const a = new ItemAssembler("t1");
    a.push(plan(1, [{ content: "one", status: "pending" }]));
    a.push(plan(2, [{ content: "one", status: "pending" }]));
    const p = a.list()[0];
    expect(p.seqTo).toBe(2); // the event still lands on the item
    expect(p.revisions).toHaveLength(1);
  });

  it("caps the trail at PLAN_REVISIONS_MAX, oldest dropped", () => {
    const a = new ItemAssembler("t1");
    a.push(plan(1, [{ content: "s", status: "pending" }]));
    for (let i = 0; i < PLAN_REVISIONS_MAX + 5; i++) {
      a.push(plan(2 + i, [{ content: `s${i}`, status: "pending" }]));
    }
    const p = a.list()[0];
    expect(p.revisions).toHaveLength(PLAN_REVISIONS_MAX);
    expect(p.revisions?.[0].seq).toBe(7); // seqs 1..26 logged, oldest 6 evicted
    expect(p.revisions?.at(-1)?.entries[0].content).toBe("s24");
  });

  it("ignores a stale replay (seq < seqFrom) entirely", () => {
    const a = new ItemAssembler("t1");
    a.push(plan(5, [{ content: "one", status: "pending" }]));
    a.push(plan(3, [{ content: "old", status: "completed" }]));
    const p = a.list()[0];
    expect(p.entries).toEqual([{ content: "one", status: "pending" }]);
    expect(p.seqTo).toBe(5);
    expect(p.revisions).toHaveLength(1);
  });

  it("itemRev still changes on every real update", () => {
    const a = new ItemAssembler("t1");
    a.push(plan(1, [{ content: "one", status: "pending" }]));
    const rev = itemRev(a.list()[0]);
    a.push(plan(2, [{ content: "one", status: "in_progress" }]));
    expect(itemRev(a.list()[0])).not.toBe(rev);
  });
});

describe("request cards", () => {
  const req = (seq: number, requestId: string, extra: Record<string, unknown> = {}) =>
    ({ seq, type: "client_request", data: { requestId, method: "session/request_permission", params: {}, ...extra } });

  it("land at the position they were asked — not piled at the tail", () => {
    const a = new ItemAssembler("t1");
    a.push(upd(1, { sessionUpdate: "tool_call", toolCallId: "c1", title: "Ran rm", status: "in_progress" }));
    a.push(req(2, "r1"));
    a.push(upd(3, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "next" } }));
    const items = a.list();
    expect(items.map((i) => i.kind)).toEqual(["tool", "request", "text"]);
    expect(items[1]).toMatchObject({ id: "req-r1", requestId: "r1", resolved: false });
  });

  it("replayed requests update in place; done resolves them", () => {
    const a = new ItemAssembler("t1");
    a.push(req(1, "r1", { params: { a: 1 } }));
    a.push(upd(2, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }));
    // reconnect replays pending requests — same card, newer params, no dup
    a.push(req(3, "r1", { params: { a: 2 } }));
    expect(a.list().filter((i) => i.kind === "request")).toHaveLength(1);
    expect(a.list()[0]).toMatchObject({ params: { a: 2 }, seqFrom: 1, seqTo: 3 });
    a.push({ seq: 4, type: "client_request_done", data: { requestId: "r1" } });
    expect(a.list()[0]).toMatchObject({ resolved: true, done: true });
  });

  it("done carries resolvedWith; a replayed request clears it", () => {
    const a = new ItemAssembler("t1");
    a.push(req(1, "r1"));
    a.push({ seq: 2, type: "client_request_done", data: { requestId: "r1", resolvedWith: "Allow once" } });
    expect(a.list()[0]).toMatchObject({ resolved: true, resolvedWith: "Allow once" });
    // reconnect replays the request unresolved — stale outcome must not linger
    a.push(req(3, "r1"));
    expect(a.list()[0]).toMatchObject({ resolved: false, resolvedWith: undefined });
  });
});
