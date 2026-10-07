import { describe, expect, it } from "vitest";
import {
  applyDurableDelta,
  applyDurableSnapshot,
  applyItemsFrame,
  applyViewFrame,
  emptySessionState,
  prependTranscript,
  reduceEvent,
  renderItems,
  transcriptToChatItems,
  type SessionState,
  type WebEvent,
} from "../lib/client/model";
import type { TranscriptItem } from "../lib/transcript";
import type { AssembledItem } from "../lib/acp/itemAssembler";
import { SessionViewStore, type ViewFrame, type ViewPatch } from "../lib/acp/sessionView";

let seq = 0;
const ev = (type: string, data: unknown, sessionId = "s1"): WebEvent => ({
  seq: ++seq,
  type,
  sessionId,
  data,
  ts: Date.now(),
});

const fold = (events: WebEvent[], s: SessionState = emptySessionState()) => {
  for (const e of events) reduceEvent(s, e);
  return s;
};

const row = (id: number, role: TranscriptItem["role"], text: string, extra: Partial<TranscriptItem> = {}): TranscriptItem =>
  ({ id, role, text, ts: id, ...extra });

const prov = (id: string, kind: AssembledItem["kind"], extra: Partial<AssembledItem> = {}): AssembledItem =>
  ({ id, kind, done: false, seqFrom: 1, seqTo: 1, ...extra });

describe("reduceEvent — session meta", () => {
  it("captures mode + config + command + title updates", () => {
    const s = fold([
      ev("session_update", {
        sessionUpdate: "current_mode_update",
        currentModeId: "plan",
        availableModes: [{ id: "plan", name: "Plan" }],
      }),
      ev("session_update", {
        sessionUpdate: "config_option_update",
        configOptions: [{ id: "model", currentValue: "swe-2-max" }],
      }),
      ev("session_update", {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "help", description: "h" }],
      }),
      ev("session_update", { sessionUpdate: "session_info_update", title: "titled" }),
      ev("session_update", {
        sessionUpdate: "usage_update",
        used: 10,
        size: 100,
        _meta: { "cognition.ai/inputTokens": 7, "cognition.ai/outputTokens": 3 },
      }),
    ]);
    expect(s.modeId).toBe("plan");
    expect(s.modes).toHaveLength(1);
    expect(s.configOptions?.[0].id).toBe("model");
    expect(s.commands).toHaveLength(1);
    expect(s.title).toBe("titled");
    expect(s.usage).toMatchObject({ used: 10, size: 100, inputTokens: 7, outputTokens: 3 });
  });

  it("ignores turn-content session_updates — the server assembles the turn", () => {
    // user_message, *_chunk, tool_call*, plan all belong to the provisional
    // region; a client that still assembled them would double-render
    const s = fold([
      ev("session_update", { sessionUpdate: "user_message", content: [{ type: "text", text: "hi" }] }),
      ev("session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } }),
      ev("session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }),
      ev("session_update", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Ran ls", status: "in_progress" }),
      ev("session_update", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
      ev("session_update", { sessionUpdate: "plan", entries: [{ content: "x", status: "pending" }] }),
    ]);
    expect(s.items).toHaveLength(0);
    expect(renderItems(s)).toHaveLength(0);
  });

  it("session_state partial events only apply carried fields", () => {
    const s = fold([
      ev("session_state", { running: true, queued: 2, queue: [{ id: "q1", text: "a" }, { id: "q2", text: "b" }] }),
      ev("session_state", { detached: true }),
    ]);
    expect(s.running).toBe(false); // detached means the turn can't be running
    expect(s.queued).toBe(2); // queued prompts still exist server-side
    expect(s.queueItems).toHaveLength(2);

    const s2 = fold([
      ev("session_state", { running: true, queued: 1, queue: [{ id: "q1", text: "a" }] }),
      ev("session_state", { running: true, queued: 0 }),
    ]);
    expect(s2.queued).toBe(0);
    expect(s2.queueItems).toEqual([]);
  });

  it("turn_end clears running and keeps usage", () => {
    const s = fold([
      ev("session_state", { running: true }),
      ev("turn_end", { usage: { totalTokens: 42, inputTokens: 40, outputTokens: 2 } }),
    ]);
    expect(s.running).toBe(false);
    expect(s.usage).toMatchObject({ used: 42, inputTokens: 40, outputTokens: 2 });
  });

  it("turn_error surfaces a notice in the overlay", () => {
    const s = fold([ev("turn_error", { message: "boom" })]);
    expect(s.running).toBe(false);
    expect(s.items[0]).toMatchObject({ kind: "notice", text: "Error: boom" });
    expect(renderItems(s)).toEqual(s.items);
  });

  it("a notice overlays text without touching running state", () => {
    // send-now failures land mid-turn — unlike turn_error they must not
    // flip the session back to idle
    const s = fold([
      ev("session_state", { running: true }),
      ev("notice", { text: "Send-now failed — the prompt was returned to the queue" }),
    ]);
    expect(s.running).toBe(true);
    expect(s.items[0]).toMatchObject({ kind: "notice", text: "Send-now failed — the prompt was returned to the queue" });
  });

  it("a new turn retires previous notices — errors don't sit at the tail forever", () => {
    const s = fold([
      ev("turn_error", { message: "daily usage quota exhausted" }),
      ev("session_state", { running: true }), // next prompt starts
    ]);
    expect(s.items).toEqual([]);

    // request cards are untouched by the retire rule
    const s2 = fold([
      ev("turn_error", { message: "boom" }),
      ev("client_request", { requestId: "r1", method: "session/request_permission", params: {} }),
      ev("session_state", { running: true }),
    ]);
    expect(s2.items).toEqual([
      expect.objectContaining({ kind: "request", requestId: "r1" }),
    ]);

    // mid-turn session_state events keep the running session's notices —
    // only the idle→running flip retires them
    const s3 = fold([
      ev("session_state", { running: true }),
      ev("notice", { text: "Send-now failed" }),
      ev("session_state", { running: true, queued: 1 }),
    ]);
    expect(s3.items).toEqual([expect.objectContaining({ kind: "notice", text: "Send-now failed" })]);
  });

  it("dedupes identical notice text — a repeated error replaces its stale copy", () => {
    const s = fold([
      ev("turn_error", { message: "quota" }),
      ev("turn_error", { message: "quota" }),
      ev("turn_error", { message: "quota" }),
    ]);
    expect(s.items).toHaveLength(1);
    // the surviving copy is the newest instance (latest seq/id)
    expect(s.items[0].id).toBe(`ev-${seq}`);
  });

  it("bounds the overlay at 5 notices — oldest retire first", () => {
    const s = fold(
      Array.from({ length: 7 }, (_, i) => ev("notice", { text: `n${i}` })),
    );
    const texts = s.items.filter((i) => i.kind === "notice").map((i) => (i as { text: string }).text);
    expect(texts).toEqual(["n2", "n3", "n4", "n5", "n6"]);
  });

  it("notice_dismiss removes only that notice", () => {
    const s = fold([
      ev("turn_error", { message: "a" }),
      ev("notice", { text: "b" }),
      ev("client_request", { requestId: "r1", method: "m", params: {} }),
    ]);
    const first = s.items[0];
    fold([ev("notice_dismiss", { id: first.id })], s);
    expect(s.items).toEqual([
      expect.objectContaining({ kind: "notice", text: "b" }),
      expect.objectContaining({ kind: "request", requestId: "r1" }),
    ]);
    // unknown / non-notice ids are no-ops
    fold([ev("notice_dismiss", { id: "nope" }), ev("notice_dismiss", { id: "req-r1" })], s);
    expect(s.items).toHaveLength(2);
  });

  it("tracks client requests and marks them resolved — updates in place", () => {
    const s = fold([
      ev("client_request", { requestId: "r1", method: "session/request_permission", params: { a: 1 } }),
      ev("client_request", { requestId: "r1", method: "session/request_permission", params: { a: 2 } }),
      ev("client_request_done", { requestId: "r1" }),
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "request", requestId: "r1", resolved: true });
    expect(s.items[0]).toMatchObject({ kind: "request", params: { a: 2 } });
  });

  it("agent_stopped ends running; terminal_created dedups", () => {
    const s = fold([
      ev("session_state", { running: true }),
      ev("notification", { method: "_cognition.ai/agent_stopped", params: { stats: { n: 1 } } }),
      ev("notification", { method: "_devin-web/terminal_created", params: { terminalId: "x1" } }),
      ev("notification", { method: "_devin-web/terminal_created", params: { terminalId: "x1" } }),
    ]);
    expect(s.running).toBe(false);
    expect(s.turnStats).toEqual({ n: 1 });
    expect(s.terminalIds).toEqual(["x1"]);
  });

  it("watchers meta event sets the badge", () => {
    const s = fold([ev("watchers", { count: 3 })]);
    expect(s.watchers).toBe(3);
  });
});

describe("items frame → provisional region", () => {
  it("maps assembled items and replaces the region wholesale — never merges", () => {
    const st = emptySessionState();
    applyItemsFrame(st, {
      provisional: [
        prov("p-1-0", "text", { role: "thought", text: "thinking" }),
        prov("p-1-1", "tool", { tool: { toolCallId: "t1", title: "Ran x", status: "in_progress" } }),
        prov("p-1-2", "plan", { entries: [{ content: "step", status: "in_progress" }] }),
      ],
      durableThrough: 42,
    });
    expect(st.durableThrough).toBe(42);
    expect(renderItems(st).map((i) => i.id)).toEqual(["p-1-0", "p-1-1", "p-1-2"]);
    applyItemsFrame(st, {
      // The assembler advances seqTo for each tool_call_update.
      provisional: [prov("p-1-1", "tool", { seqTo: 2, tool: { toolCallId: "t1", title: "Ran x", status: "completed" } })],
    });
    expect(renderItems(st).map((i) => i.id)).toEqual(["p-1-1"]);
    expect(renderItems(st)[0]).toMatchObject({ kind: "tool", tool: { status: "completed" } });
  });

  it("an empty provisional list clears the region at turn end", () => {
    const st = emptySessionState();
    applyItemsFrame(st, { provisional: [prov("p-1-0", "text", { role: "agent", text: "x" })] });
    applyDurableSnapshot(st, [row(70, "assistant", "x")], false);
    applyItemsFrame(st, { provisional: [] });
    expect(renderItems(st).map((i) => i.id)).toEqual(["bf-70"]);
  });
});

describe("applyDurableDelta — watermark", () => {
  it("drops durable rows that belong to the running turn", () => {
    // 증상 2: 턴 중 커밋된 행이 durable로 들어가면 provisional의 thinking이
    // 그 아래로 가라앉는다 — 바닥 뭉침의 재현 조건
    const st = emptySessionState();
    applyDurableSnapshot(st, [row(100, "assistant", "older turn")], false);
    st.durableThrough = 100;
    applyItemsFrame(st, {
      provisional: [
        prov("p-1-0", "text", { role: "agent", text: "answer" }),
        prov("p-1-1", "text", { role: "thought", text: "thinking", seqFrom: 2, seqTo: 2 }),
      ],
    });
    // CLI commits the running turn's answer mid-turn — must NOT enter durable
    applyDurableDelta(st, [row(140, "assistant", "answer")]);
    expect(renderItems(st).map((i) => (i.kind === "text" ? i.text : ""))).toEqual([
      "older turn",
      "answer",
      "thinking",
    ]);
    // …until the server closes the turn and advances the watermark
    applyItemsFrame(st, { provisional: [], durableThrough: 160 });
    applyDurableDelta(st, [row(140, "assistant", "answer")]);
    expect(renderItems(st).map((i) => (i.kind === "text" ? i.text : ""))).toEqual([
      "older turn",
      "answer",
    ]);
  });

  it("a same-message recommit updates the durable row in place", () => {
    const st = emptySessionState();
    applyDurableSnapshot(st, [
      row(10, "assistant", "draft", { messageId: "m1" }),
    ], false);
    applyDurableDelta(st, [
      row(20, "assistant", "draft final", { messageId: "m1" }),
    ]);
    expect(st.durable?.map((i) => i.id)).toEqual(["bf-20"]);
    expect(st.durable?.[0]).toMatchObject({ kind: "text", text: "draft final" });
  });

  it("re-delivery of the same rows is a no-op", () => {
    const st = emptySessionState();
    applyDurableDelta(st, [row(1, "assistant", "a"), row(2, "assistant", "b")]);
    applyDurableDelta(st, [row(1, "assistant", "a"), row(2, "assistant", "b")]);
    expect(st.durable?.map((i) => i.id)).toEqual(["bf-1", "bf-2"]);
  });

  it("records durable rows above the live watermark — the two-region sink event", () => {
    // the seed/delta paths filter and clamp, so rows above durableThrough can
    // only appear via a bug — e.g. an unclamped seed arriving before the first
    // items frame freezes the watermark. Counting the EVENT (not the tail's
    // shape) is what makes this a zero-false-positive tripwire.
    const st = emptySessionState();
    applyDurableSnapshot(st, [
      row(10, "assistant", "old"),
      row(11, "assistant", "mid-turn commit slipped in"),
    ], false);
    applyItemsFrame(st, {
      provisional: [prov("p-1-0", "text", { role: "thought", text: "t" })],
      durableThrough: 10,
    });
    expect(st.sunkLive).toMatchObject({ pushed: 1, inserted: 1, at: 1 });
  });

  it("stays silent when durable rows respect the watermark", () => {
    const st = emptySessionState();
    applyDurableSnapshot(st, [row(10, "assistant", "old")], false);
    applyItemsFrame(st, {
      provisional: [prov("p-1-0", "text", { role: "thought", text: "t" })],
      durableThrough: 10,
    });
    applyDurableDelta(st, [row(11, "assistant", "turn commit")]); // dropped by filter
    applyDurableDelta(st, [row(9, "assistant", "older backfill")]); // admitted below
    expect(st.sunkLive).toBeUndefined();
    expect(st.durable?.map((i) => i.id)).toEqual(["bf-10", "bf-9"]); // deltas append in arrival order
  });
});

describe("prependTranscript (load earlier)", () => {
  const seedRows = [row(10, "user", "q"), row(11, "assistant", "a")];
  const olderRows = [row(8, "user", "old q"), row(9, "assistant", "old a")];

  it("prepends older rows ahead of the durable region", () => {
    const s = fold([
      ev("client_request", { requestId: "r1", method: "m", params: {} }),
    ]);
    applyDurableSnapshot(s, seedRows, true);
    prependTranscript(s, olderRows, true);
    expect(renderItems(s).map((i) => i.id)).toEqual(["bf-8", "bf-9", "bf-10", "bf-11", "req-r1"]);
    expect(s.historyTruncated).toBe(true);
  });

  it("drops seam overlap by id — a re-click can't duplicate", () => {
    const s = emptySessionState();
    applyDurableSnapshot(s, seedRows, true);
    prependTranscript(s, [...olderRows, seedRows[0]], false); // bf-10 already present
    expect(s.durable?.map((i) => i.id)).toEqual(["bf-8", "bf-9", "bf-10", "bf-11"]);
    expect(s.historyTruncated).toBe(false); // page reached the root → disarm
  });
});

describe("transcriptToChatItems", () => {
  it("maps roles, drops placeholder/empty rows, keeps tool state", () => {
    const items = transcriptToChatItems([
      row(1, "user", "u"),
      row(2, "assistant", "a"),
      row(3, "assistant", "[image]"),
      row(4, "tool", "raw", { toolCallId: "t9" }), // no state → skipped
      row(5, "tool", "", { toolCallId: "t9", tool: { toolCallId: "t9" } }),
      row(6, "assistant", "   "),
    ]);
    expect(items.map((i) => i.id)).toEqual(["bf-1", "bf-2", "bf-5"]);
    expect(items[2]).toMatchObject({ kind: "tool", tool: { toolCallId: "t9" } });
  });
});

describe("renderItems", () => {
  it("concatenates durable ++ provisional ++ overlay in order", () => {
    const st = emptySessionState();
    applyDurableSnapshot(st, [row(1, "user", "u")], false);
    applyItemsFrame(st, { provisional: [prov("p-1-0", "text", { role: "agent", text: "a" })] });
    reduceEvent(st, ev("client_request", { requestId: "r1", method: "m", params: {} }));
    expect(renderItems(st).map((i) => i.id)).toEqual(["bf-1", "p-1-0", "req-r1"]);
    // the overlay never receives transcript content
    expect(st.items.map((i) => i.id)).toEqual(["req-r1"]);
  });
});

describe("retained items (post-turn ephemera)", () => {
  const ret = (id: string, anchorNode: number, extra: Partial<AssembledItem> = {}): AssembledItem =>
    ({ id, kind: "text", role: "thought", text: `thought-${id}`, done: true, seqFrom: 1, seqTo: 2, anchorNode, ...extra });

  it("interleaves retained items before the first durable row past the anchor", () => {
    const st = emptySessionState();
    applyDurableSnapshot(st,
      [row(10, "user", "q"), row(11, "assistant", "a"), row(12, "assistant", "a2")],
      false, [ret("p-t-0", 10), ret("p-t-1", 11)]);
    expect(renderItems(st).map((i) => i.id))
      .toEqual(["bf-10", "p-t-0", "bf-11", "p-t-1", "bf-12"]);
  });

  it("items frame replaces retained wholesale", () => {
    const st = emptySessionState();
    applyDurableSnapshot(st, [row(10, "assistant", "a"), row(11, "assistant", "b")], false);
    applyItemsFrame(st, { provisional: [], retained: [ret("p-t-0", 10)] });
    applyItemsFrame(st, { provisional: [], retained: [ret("p-t-9", 11)] });
    expect(renderItems(st).map((i) => i.id)).toEqual(["bf-10", "bf-11", "p-t-9"]);
  });

  it("anchor == last row lands on the tail seam; above-window anchors skip", () => {
    const st = emptySessionState();
    applyDurableSnapshot(st, [row(10, "assistant", "a"), row(11, "assistant", "b")], false,
      [ret("p-t-0", 11), ret("p-t-9", 99)]);
    expect(renderItems(st).map((i) => i.id)).toEqual(["bf-10", "bf-11", "p-t-0"]);
  });

  it("below-window anchors pin to the top unless earlier pages exist", () => {
    const st = emptySessionState();
    applyDurableSnapshot(st, [row(10, "assistant", "a"), row(11, "assistant", "b")], false,
      [ret("p-t-0", 5)]);
    expect(renderItems(st).map((i) => i.id)).toEqual(["p-t-0", "bf-10", "bf-11"]);
    const st2 = emptySessionState();
    applyDurableSnapshot(st2, [row(10, "assistant", "a"), row(11, "assistant", "b")], true,
      [ret("p-t-0", 5)]);
    expect(renderItems(st2).map((i) => i.id)).toEqual(["bf-10", "bf-11"]);
  });

  it("retained stays anchored while a new turn's provisional runs", () => {
    const st = emptySessionState();
    applyDurableSnapshot(st, [row(10, "assistant", "a"), row(11, "assistant", "b")], false,
      [ret("p-t-0", 10)]);
    applyItemsFrame(st, {
      provisional: [prov("p-live-0", "text", { role: "agent", text: "running" })],
      retained: [ret("p-t-0", 10)],
    });
    expect(renderItems(st).map((i) => i.id))
      .toEqual(["bf-10", "p-t-0", "bf-11", "p-live-0"]);
  });

  it("a wrongly-retained spine item is caught by the integrity dupes check", async () => {
    const { checkIntegrity } = await import("../lib/client/integrity");
    const st = emptySessionState();
    const long = "x".repeat(150);
    applyDurableSnapshot(st, [row(10, "assistant", long)], false, [
      { id: "p-t-0", kind: "text", role: "agent", text: long, done: true, seqFrom: 1, seqTo: 1, anchorNode: 10 },
    ]);
    expect(checkIntegrity(renderItems(st)).dupes.length).toBeGreaterThan(0);
  });
});

describe("malformed wire data", () => {
  const evAt = (type: string, data: unknown) =>
    ({ seq: 1, type, data, ts: 0 }) as Parameters<typeof reduceEvent>[1];

  it("null data on any event type does not throw", () => {
    for (const t of [
      "turn_end",
      "turn_error",
      "session_state",
      "session_update",
      "notification",
      "client_request",
      "client_request_done",
      "watchers",
      "replay_done",
    ]) {
      const s = emptySessionState();
      expect(() => reduceEvent(s, evAt(t, null))).not.toThrow();
    }
  });

  it("non-array collections are ignored, not cast", () => {
    const s = emptySessionState();
    reduceEvent(s, evAt("session_update", { sessionUpdate: "current_mode_update", availableModes: "x" }));
    expect(s.modes).toBeUndefined();
    reduceEvent(s, evAt("session_state", { queue: "nope" }));
    expect(s.queueItems).toBeUndefined();
    applyItemsFrame(s, { provisional: "nope" });
    expect(s.provisional).toEqual([]);
  });

  it("non-string title/terminalId/queue fields are dropped", () => {
    const s = emptySessionState();
    reduceEvent(s, evAt("session_update", { sessionUpdate: "session_info_update", title: 42 }));
    expect(s.title).toBeUndefined();
    reduceEvent(s, evAt("notification", { method: "_devin-web/terminal_created", params: { terminalId: 7 } }));
    expect(s.terminalIds).toEqual([]);
    reduceEvent(s, evAt("session_state", { queued: "many" }));
    expect(s.queued).toBe(0);
  });

  it("notification without params does not crash", () => {
    const s = emptySessionState();
    expect(() =>
      reduceEvent(s, evAt("notification", { method: "_cognition.ai/agent_stopped" })),
    ).not.toThrow();
    expect(s.running).toBe(false);
  });
});

describe("request cards — position", () => {
  it("a request the provisional region carries renders at its position; the overlay copy is dropped", () => {
    const st = emptySessionState();
    // the overlay entry lands instantly on the client_request event…
    reduceEvent(st, ev("client_request", { requestId: "r1", method: "session/request_permission", params: {} }));
    // …then the items frame carries the same card mid-region — one render,
    // at the assembled position, between the tool call and the next text
    applyItemsFrame(st, {
      provisional: [
        prov("p-1-0", "tool", { tool: { toolCallId: "t1", status: "in_progress" } }),
        prov("req-r1", "request", { requestId: "r1", method: "session/request_permission", params: {} }),
        prov("p-1-2", "text", { role: "agent", text: "next" }),
      ],
    });
    expect(renderItems(st).map((i) => i.id)).toEqual(["p-1-0", "req-r1", "p-1-2"]);
    expect(renderItems(st)[1]).toMatchObject({ kind: "request", requestId: "r1" });
  });

  it("resolved cards retire with the turn — unanswered ones stay answerable", () => {
    const st = emptySessionState();
    reduceEvent(st, ev("client_request", { requestId: "r1", method: "m", params: {} }));
    reduceEvent(st, ev("client_request", { requestId: "r2", method: "m", params: {} }));
    reduceEvent(st, ev("client_request_done", { requestId: "r1" }));
    reduceEvent(st, ev("turn_end", {}));
    // r1 was answered — retires with the turn instead of piling at the tail
    expect(st.items.map((i) => i.id)).toEqual(["req-r2"]);
  });
});

describe("items frame identity", () => {
  const wire = <T,>(x: T): T => JSON.parse(JSON.stringify(x)); // every frame is a fresh parse

  it("reuses the ChatItem object for an unchanged assembled item", () => {
    const st = emptySessionState();
    const a = prov("p-9-0", "tool", { tool: { toolCallId: "t9", title: "x", status: "in_progress" }, seqTo: 5 });
    const b = prov("p-9-1", "text", { role: "agent", text: "hi", seqTo: 6 });
    applyItemsFrame(st, { provisional: wire([a, b]) });
    const first = st.provisional!;
    applyItemsFrame(st, { provisional: wire([a, { ...b, text: "hi there", seqTo: 7 }]) });
    expect(st.provisional![0]).toBe(first[0]);
    expect(st.provisional![1]).not.toBe(first[1]);
    expect(st.provisional![1]).toMatchObject({ text: "hi there" });
  });

  it("a done or resolved flip at the same seqTo is a new object", () => {
    const st = emptySessionState();
    const r = prov("req-1", "request", { requestId: "1", method: "session/request_permission", params: {}, seqTo: 3 });
    applyItemsFrame(st, { provisional: wire([r]) });
    const before = st.provisional![0];
    applyItemsFrame(st, { provisional: wire([{ ...r, resolved: true, done: true }]) });
    expect(st.provisional![0]).not.toBe(before);
    expect(st.provisional![0]).toMatchObject({ resolved: true });
  });

  it("retained items keep identity across frames", () => {
    const st = emptySessionState();
    const t = prov("p-8-0", "text", { role: "thought", text: "t", done: true, anchorNode: 40 });
    applyItemsFrame(st, { provisional: [], retained: wire([t]) });
    const before = st.retained![0];
    applyItemsFrame(st, { provisional: [], retained: wire([t]) });
    expect(st.retained![0]).toBe(before);
  });
});

describe("applyViewFrame (D V2-2)", () => {
  const wire = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  const snap = (over: Partial<Extract<ViewFrame, { t: "snapshot" }>> = {}): ViewFrame => ({
    t: "snapshot", v: 3, meta: { ...emptySessionState(), title: "T" },
    durable: [row(10, "user", "hi")], durableTruncated: false,
    provisional: [], retained: [], durableThrough: 10, ...over,
  });

  it("replaces metadata and both regions without checking old region state", () => {
    const st = emptySessionState();
    applyDurableSnapshot(st, [row(30, "assistant", "old")], true);
    applyItemsFrame(st, {
      provisional: [prov("p-old", "text", { role: "thought", text: "old" })],
      durableThrough: 30,
    });
    st.running = true;
    st.runningSince = 123;
    st.queueItems = [{ id: "q", text: "old" }];
    st.watchers = 2;
    st.modeId = "old";
    expect(applyViewFrame(st, wire(snap({
      provisional: [prov("p-1-0", "text", { role: "agent", text: "x" })],
    })))).toBe("ok");
    expect(st.v).toBe(3);
    expect(st.title).toBe("T");
    expect(st.running).toBe(false);
    expect(st.runningSince).toBeUndefined();
    expect(st.queueItems).toBeUndefined();
    expect(st.watchers).toBeUndefined();
    expect(st.modeId).toBeUndefined();
    expect(st.historyTruncated).toBe(false);
    expect(st.durableThrough).toBe(10);
    expect(st.sunkLive).toBeUndefined();
    expect(renderItems(st).map((i) => i.id)).toEqual(["bf-10", "p-1-0"]);
  });

  it("roundtrips real store patches after every add, reorder, update, removal and metadata clear", () => {
    const patches: ViewPatch[] = [];
    const store = new SessionViewStore({ publish: (_sid, p) => patches.push(p), persist: () => {}, load: () => null });
    const st = emptySessionState();
    expect(applyViewFrame(st, wire(snap({ v: 0, meta: store.meta("s") })))).toBe("ok");
    const a = prov("p-1-0", "text", { role: "thought", text: "t", seqTo: 1 });
    const aDone = { ...a, done: true };
    const b = prov("p-1-1", "tool", { tool: { toolCallId: "c", title: "x", status: "in_progress" }, seqTo: 2 });
    const b2 = { ...b, tool: { toolCallId: "c", title: "x", status: "completed" as const }, seqTo: 4 };
    const c = prov("p-1-2", "text", { role: "agent", text: "a", seqTo: 3 });
    const c2 = { ...c, text: "ab", seqTo: 5 };
    const steps: AssembledItem[][] = [
      [a], [a, b], [b, a], [b2, a, c], [b2, aDone, c2], [b2, c2],
    ];
    for (const list of steps) {
      const before = patches.length;
      store.regions("s", { provisional: list, durableThrough: 10 });
      expect(patches).toHaveLength(before + 1);
      const patch = wire(patches.at(-1)!);
      expect(applyViewFrame(st, patch)).toBe("ok");
      expect(st.provisionalRaw).toEqual(wire(list));
      expect(st.provisional?.map((i) => i.id)).toEqual(list.map((i) => i.id));
      expect(st.v).toBe(patch.v);
    }
    store.setMeta("s", { running: true, runningSince: 99, title: "live", queueItems: [{ id: "q", text: "queued" }] });
    expect(applyViewFrame(st, wire(patches.at(-1)!))).toBe("ok");
    expect(st).toMatchObject({ running: true, runningSince: 99, title: "live", queueItems: [{ id: "q", text: "queued" }] });
    store.setMeta("s", { runningSince: undefined, title: undefined, queueItems: undefined });
    const clearPatch = wire(patches.at(-1)!);
    expect(clearPatch.clearMeta).toEqual(expect.arrayContaining(["runningSince", "title", "queueItems"]));
    expect(applyViewFrame(st, clearPatch)).toBe("ok");
    expect(st.runningSince).toBeUndefined();
    expect(st.title).toBeUndefined();
    expect(st.queueItems).toBeUndefined();
    expect(st.running).toBe(true);
    expect(st.v).toBe(store.version("s"));
  });

  it("re-seeds regions and overlay from snapshots and replaces retained items wholesale", () => {
    const st = emptySessionState();
    const retained = (id: string) => prov(id, "text", {
      role: "thought", text: id, done: true, anchorNode: 10,
    });
    const request = { id: "req-r", kind: "request" as const, requestId: "r", method: "m", params: {} };
    const seeded = snap({
      durable: [row(10, "user", "hi"), row(11, "assistant", "answer")],
      durableThrough: 11, durableTruncated: true,
      meta: { ...emptySessionState(), items: [request] },
      retained: [retained("r-old")],
    });
    applyViewFrame(st, wire(seeded));
    expect(st.historyTruncated).toBe(true);
    expect(renderItems(st).map(i => i.id)).toEqual(["bf-10", "r-old", "bf-11", "req-r"]);
    applyViewFrame(st, wire(seeded));
    expect(renderItems(st).map(i => i.id)).toEqual(["bf-10", "r-old", "bf-11", "req-r"]);
    applyViewFrame(st, wire(snap({ v: 4, retained: [retained("r-new")] })));
    expect(st.historyTruncated).toBe(false);
    expect(renderItems(st).map(i => i.id)).toEqual(["bf-10", "r-new"]);
    applyViewFrame(st, { t: "patch", v: 5, retained: [retained("r-patch")] });
    expect(st.retained?.map(i => i.id)).toEqual(["r-patch"]);
    applyViewFrame(st, { t: "patch", v: 6, meta: { title: "live" } });
    expect(st.retained?.map(i => i.id)).toEqual(["r-patch"]);
    applyViewFrame(st, { t: "patch", v: 7, retained: [] });
    expect(st.retained).toEqual([]);
  });

  it("rejects stale, skipped, unknown and duplicate order IDs without any mutation", () => {
    const st = emptySessionState();
    applyViewFrame(st, snap({ v: 5, provisional: [prov("p-known", "text", { role: "agent", text: "x" })] }));
    const before = JSON.stringify(st);
    const raw = st.provisionalRaw;
    const rendered = st.provisional;
    expect(applyViewFrame(st, { t: "patch", v: 5, meta: { title: "old" } })).toBe("stale");
    expect(applyViewFrame(st, { t: "patch", v: 7, meta: { title: "future" } })).toBe("gap");
    expect(applyViewFrame(st, { t: "patch", v: 6, meta: { title: "bad" }, prov: { order: ["p-nope"], upsert: [] } })).toBe("gap");
    expect(applyViewFrame(st, { t: "patch", v: 6, clearMeta: ["title"], prov: { order: ["p-known", "p-known"], upsert: [] } })).toBe("gap");
    expect(JSON.stringify(st)).toBe(before);
    expect(st.provisionalRaw).toBe(raw);
    expect(st.provisional).toBe(rendered);
  });

  it("keeps unchanged rendered item identity across reordered patches", () => {
    const st = emptySessionState();
    const a = prov("p-2-0", "text", { role: "agent", text: "x", seqTo: 1 });
    const b = prov("p-2-1", "text", { role: "agent", text: "y", seqTo: 2 });
    applyViewFrame(st, snap({ v: 1, provisional: [a, b] }));
    const first = st.provisional![0];
    const second = st.provisional![1];
    const rawFirst = st.provisionalRaw![0];
    const rawSecond = st.provisionalRaw![1];
    expect(applyViewFrame(st, { t: "patch", v: 2, prov: { order: ["p-2-1", "p-2-0"], upsert: [] } })).toBe("ok");
    expect(st.provisional).toEqual([second, first]);
    expect(st.provisional![0]).toBe(second);
    expect(st.provisional![1]).toBe(first);
    expect(st.provisionalRaw).toEqual([b, a]);
    expect(st.provisionalRaw![0]).toBe(rawSecond);
    expect(st.provisionalRaw![1]).toBe(rawFirst);
  });
});
