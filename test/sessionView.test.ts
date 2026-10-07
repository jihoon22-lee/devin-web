import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionViewStore, type ViewPatch } from "../lib/acp/sessionView";
import { META_KEYS } from "../lib/client/viewMeta";
import type { AssembledItem } from "../lib/acp/itemAssembler";

let seq = 0;
const ev = (type: string, data: unknown, sessionId = "s") => ({ seq: ++seq, type, sessionId, data, ts: 1000 + seq });
const item = (id: string, over: Partial<AssembledItem> = {}): AssembledItem =>
  ({ id, kind: "text", role: "agent", text: id, done: false, seqFrom: 1, seqTo: 1, ...over });

function store(load: Record<string, unknown> | null = null) {
  const published: ViewPatch[] = [];
  const persisted: Record<string, unknown>[] = [];
  const s = new SessionViewStore({
    publish: (_sid, p) => published.push(p),
    persist: (_sid, m) => persisted.push(m as Record<string, unknown>),
    load: () => load as never,
  });
  return { s, published, persisted };
}

afterEach(() => vi.useRealTimers());

describe("SessionViewStore meta", () => {
  it("derives meta with the client reducer and publishes numbered patches", () => {
    const { s, published } = store();
    s.observe(ev("session_update", { sessionUpdate: "config_option_update", configOptions: [{ id: "mode" }] }));
    s.observe(ev("session_state", { running: true, queued: 0, queue: [] }));
    expect(published.map((p) => p.v)).toEqual([1, 2]);
    expect(published[0].meta).toEqual({ configOptions: [{ id: "mode" }] });
    expect(s.meta("s")).toMatchObject({ configOptions: [{ id: "mode" }], running: true });
  });

  it("ignores transcript content kinds", () => {
    const { s, published } = store();
    s.observe(ev("session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }));
    s.observe(ev("session_update", { sessionUpdate: "tool_call", toolCallId: "t", status: "in_progress" }));
    expect(published).toEqual([]);
    expect(s.version("s")).toBe(0);
  });

  it("settles request cards at turn end", () => {
    const { s } = store();
    s.observe(ev("session_state", { running: true }));
    s.observe(ev("client_request", { requestId: "r1", method: "session/request_permission", params: {} }));
    s.observe(ev("client_request_done", { requestId: "r1" }));
    expect(s.meta("s").items).toMatchObject([{ kind: "request", requestId: "r1", resolved: true }]);
    s.observe(ev("turn_end", {}));
    expect(s.meta("s").items).toEqual([]);
  });

  it("retires notices on the next turn's start and publishes dismiss patches", () => {
    const { s, published } = store();
    s.observe(ev("turn_error", { message: "quota" }));
    expect(s.meta("s").items).toMatchObject([{ kind: "notice", text: "Error: quota" }]);

    const id = (s.meta("s").items![0] as { id: string }).id;
    s.observe(ev("notice_dismiss", { id }));
    expect(s.meta("s").items).toEqual([]);
    expect(published.at(-1)).toMatchObject({ meta: { items: [] } });

    // a fresh error then a new turn — the error does not survive the flip
    s.observe(ev("turn_error", { message: "boom" }));
    s.observe(ev("session_state", { running: true }));
    expect(s.meta("s").items).toEqual([]);
    // mid-turn session_state does NOT retire notices that landed while running
    s.observe(ev("notice", { text: "send-now failed" }));
    s.observe(ev("session_state", { running: true, queued: 1 }));
    expect(s.meta("s").items).toMatchObject([{ kind: "notice", text: "send-now failed" }]);
  });

  it("drops a poisoned event and accepts a later valid one", () => {
    const { s, published } = store();
    const poisoned = { get running(): boolean { throw new Error("boom"); } };
    expect(() => s.observe(ev("session_state", poisoned))).not.toThrow();
    expect(published).toEqual([]);
    s.observe(ev("session_state", { running: true }));
    expect(published.at(-1)?.meta).toMatchObject({ running: true });
  });

  it("drops a nested throwing getter without changing state or patch history", () => {
    const { s, published } = store();
    s.observe(ev("session_update", { sessionUpdate: "session_info_update", title: "before" }));
    const command = Object.defineProperty({ name: "bad" }, "description", {
      enumerable: true,
      get() { throw new Error("nested getter"); },
    });
    expect(() => s.observe(ev("session_update", {
      sessionUpdate: "available_commands_update", availableCommands: [command],
    }))).not.toThrow();
    expect(s.meta("s").commands).toBeUndefined();
    expect(s.version("s")).toBe(1);
    expect(s.since("s", 0)!.map((p) => p.v)).toEqual([1]);
    expect(published).toHaveLength(1);
    s.observe(ev("session_update", { sessionUpdate: "session_info_update", title: "after" }));
    expect(s.meta("s").title).toBe("after");
    expect(s.since("s", 0)!.map((p) => p.v)).toEqual([1, 2]);
  });

  it("drops a circular payload before changing state or patch history", () => {
    const { s, published } = store();
    s.observe(ev("session_update", { sessionUpdate: "session_info_update", title: "before" }));
    const command: Record<string, unknown> = { name: "bad" };
    command.self = command;
    expect(() => s.observe(ev("session_update", {
      sessionUpdate: "available_commands_update", availableCommands: [command],
    }))).not.toThrow();
    expect(s.meta("s").commands).toBeUndefined();
    expect(s.version("s")).toBe(1);
    expect(s.since("s", 0)!.map((p) => p.v)).toEqual([1]);
    expect(published).toHaveLength(1);
    s.observe(ev("session_update", { sessionUpdate: "session_info_update", title: "after" }));
    expect(s.meta("s").title).toBe("after");
    expect(s.since("s", 0)!.map((p) => p.v)).toEqual([1, 2]);
  });

  it("lets publisher errors propagate after a valid patch is prepared", () => {
    const s = new SessionViewStore({
      publish: () => { throw new Error("publisher failed"); },
      persist: () => {},
      load: () => null,
    });
    expect(() => s.observe(ev("session_state", { running: true }))).toThrow("publisher failed");
  });

  it("loads persisted meta but never restores transient fields", () => {
    const { s } = store({ commands: [{ name: "rename" }], title: "T", running: true, queued: 5, items: [{ id: "stale" }], watchers: 4 });
    expect(s.meta("s")).toMatchObject({ commands: [{ name: "rename" }], title: "T", running: false, queued: 0, items: [] });
    expect(s.meta("s").watchers).toBeUndefined();
  });

  it("persists only durable meta keys, debounced", () => {
    vi.useFakeTimers();
    const { s, persisted } = store();
    s.observe(ev("session_update", { sessionUpdate: "available_commands_update", availableCommands: [{ name: "a" }] }));
    s.observe(ev("session_update", { sessionUpdate: "session_info_update", title: "T2" }));
    s.observe(ev("session_state", { running: true }));
    expect(persisted).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ commands: [{ name: "a" }], title: "T2" });
    expect("running" in persisted[0]).toBe(false);
  });

  it("serializes undefined changes as explicit clearMeta keys", () => {
    const { s, published } = store();
    s.observe(ev("session_state", { running: true }));
    s.observe(ev("session_state", { running: false }));
    const wire = JSON.parse(JSON.stringify(published.at(-1)));
    expect(wire.clearMeta).toContain("runningSince");
    expect(wire.meta).toEqual({ running: false });
  });

  it("only accepts declared meta keys from setMeta", () => {
    const { s, published } = store();
    s.setMeta("s", { watchers: 2, unrelated: "bad" } as never);
    expect(published.at(-1)?.meta).toEqual({ watchers: 2 });
    expect(META_KEYS).toContain("watchers");
  });
});

describe("SessionViewStore regions", () => {
  it("upserts changed revisions with the complete order", () => {
    const { s, published } = store();
    const a = item("p-1-0", { seqTo: 1 });
    const b = item("p-1-1", { seqTo: 2 });
    s.regions("s", { provisional: [a, b], durableThrough: 10 });
    expect(published.at(-1)).toMatchObject({
      prov: { order: ["p-1-0", "p-1-1"], upsert: [{ id: "p-1-0" }, { id: "p-1-1" }] },
      durableThrough: 10,
    });
    s.regions("s", { provisional: [a, { ...b, text: "bb", seqTo: 3 }], durableThrough: 10 });
    const p = published.at(-1)!;
    expect(p.prov!.upsert.map((i) => i.id)).toEqual(["p-1-1"]);
    expect(p.durableThrough).toBeUndefined();
  });

  it("does not publish an unchanged region", () => {
    const { s, published } = store();
    const a = item("p-1-0");
    s.regions("s", { provisional: [a], durableThrough: 5 });
    const n = published.length;
    s.regions("s", { provisional: [{ ...a }], durableThrough: 5 });
    expect(published.length).toBe(n);
  });

  it("represents removal with an order-only patch", () => {
    const { s, published } = store();
    const a = item("p-1-0");
    const b = item("p-1-1");
    s.regions("s", { provisional: [a, b], durableThrough: 5 });
    s.regions("s", { provisional: [b], durableThrough: 5 });
    expect(published.at(-1)!.prov).toEqual({ order: ["p-1-1"], upsert: [] });
  });

  it("keeps nested provisional history stable after producer mutation", () => {
    const { s, published } = store();
    const a = item("p-1-0", { kind: "request", params: { nested: { value: "before" } }, requestId: "r", method: "ask" });
    s.regions("s", { provisional: [a], durableThrough: 5 });
    (a.params!.nested as { value: string }).value = "after";
    expect(s.since("s", 0)![0].prov!.upsert[0].params).toEqual({ nested: { value: "before" } });
    expect(published[0].prov!.upsert[0].params).toEqual({ nested: { value: "before" } });
  });

  it("ships plan revisions on the upsert while provisional", () => {
    const { s, published } = store();
    const a = item("p-1-0", {
      kind: "plan",
      entries: [{ content: "a", status: "in_progress" }],
      revisions: [
        { seq: 1, ts: 5, entries: [{ content: "a", status: "pending" }] },
        { seq: 2, ts: 6, entries: [{ content: "a", status: "in_progress" }] },
      ],
    });
    s.regions("s", { provisional: [a], durableThrough: 5 });
    expect(published.at(-1)!.prov!.upsert[0].revisions).toEqual([
      { seq: 1, ts: 5, entries: [{ content: "a", status: "pending" }] },
      { seq: 2, ts: 6, entries: [{ content: "a", status: "in_progress" }] },
    ]);
  });

  it("keeps nested retained history stable after producer mutation", () => {
    const { s } = store();
    const a = item("p-1-0", { kind: "plan", entries: [{ content: "before", priority: "high", status: "pending" }] as never, anchorNode: 8 });
    s.regions("s", { provisional: [], retained: [a], durableThrough: 8 });
    (a.entries![0] as { content: string }).content = "after";
    expect(s.since("s", 0)![0].retained![0].entries![0].content).toBe("before");
  });

  it("does not advance region revision baselines when a patch cannot serialize", () => {
    const { s, published } = store();
    const bad = item("p-1-0", { kind: "request", requestId: "r", method: "ask", params: {} });
    bad.params!.self = bad.params;
    expect(() => s.regions("s", { provisional: [bad], durableThrough: 5 })).toThrow();
    expect(s.version("s")).toBe(0);
    expect(s.since("s", 0)).toEqual([]);
    const good = item("p-1-0", { kind: "request", requestId: "r", method: "ask", params: {} });
    s.regions("s", { provisional: [good], durableThrough: 5 });
    expect(published[0]).toMatchObject({ v: 1, prov: { upsert: [{ id: "p-1-0" }] }, durableThrough: 5 });
  });
});

describe("patch log", () => {
  it("returns a contiguous tail, current empty result, or null after eviction", () => {
    const { s } = store();
    for (let i = 0; i < 300; i++) s.setMeta("s", { title: `t${i}` });
    expect(s.version("s")).toBe(300);
    expect(s.since("s", 300)).toEqual([]);
    expect(s.since("s", 299)!.map((p) => p.v)).toEqual([300]);
    expect(s.since("s", 10)).toBeNull();
    expect(s.since("s", 301)).toBeNull();
    expect(s.since("never-seen", 5)).toBeNull();
  });

  it("does not publish an unchanged meta value", () => {
    const { s, published } = store();
    s.setMeta("s", { watchers: 2 });
    s.setMeta("s", { watchers: 2 });
    expect(published).toHaveLength(1);
  });

  it("resets version and meta on forget", () => {
    const { s } = store();
    s.setMeta("s", { title: "x" });
    s.forget("s");
    expect(s.version("s")).toBe(0);
    expect(s.meta("s").title).toBeUndefined();
  });

  it("uses actual UTF-8 bytes and evicts a lone oversized patch", () => {
    const { s, published } = store();
    s.setMeta("s", { title: "한".repeat(400_000) });
    expect(published).toHaveLength(1);
    expect(s.version("s")).toBe(1);
    expect(s.since("s", 0)).toBeNull();
    expect(s.since("s", 1)).toEqual([]);
  });

  it("does not let a caller mutate stored history", () => {
    const { s, published } = store();
    s.setMeta("s", { commands: [{ name: "before" }] as never });
    (published[0].meta!.commands![0] as { name: string }).name = "after";
    expect(s.since("s", 0)![0].meta!.commands).toEqual([{ name: "before" }]);
    const read = s.since("s", 0)!;
    (read[0].meta!.commands![0] as { name: string }).name = "later";
    expect(s.since("s", 0)![0].meta!.commands).toEqual([{ name: "before" }]);
  });

  it("does not commit setMeta state when its patch cannot serialize", () => {
    const { s, published } = store();
    const command: Record<string, unknown> = { name: "bad" };
    command.self = command;
    expect(() => s.setMeta("s", { commands: [command] as never })).toThrow();
    expect(s.meta("s").commands).toBeUndefined();
    expect(s.version("s")).toBe(0);
    expect(s.since("s", 0)).toEqual([]);
    s.setMeta("s", { commands: [{ name: "ok" }] as never });
    expect(published[0]).toMatchObject({ v: 1, meta: { commands: [{ name: "ok" }] } });
  });
});
