import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionsDb } from "./fixtures/sessions-db";
import type { WireMsg } from "../lib/stream/connections";

const stateDir = mkdtempSync(join(tmpdir(), "dw-connections-state-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;
process.env.DEVIN_CLI_DIR = stateDir; // never read the real CLI db during view snapshots
createSessionsDb(stateDir).close();
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));
const {
  attachStream,
  connectionInfo,
  detachStream,
  rewindCursor,
  sessionSeen,
  subscribe,
  unsubscribe,
} = await import("../lib/stream/connections");
const { manager } = await import("../lib/state");
import type { ViewFrame } from "../lib/acp/sessionView";
import type { AssembledItem } from "../lib/acp/itemAssembler";
import { NextRequest } from "next/server";
const { POST: subscribeRoute } = await import("../app/api/stream/subscribe/route");
const { localPool: terminalPool } = await import("../lib/acp/terminal");

let connSeq = 0;
const conn = () => `test-conn-${++connSeq}`;

// drive session/global events through the real manager singleton
const emit = (sessionId: string, type: string, data: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager() as any).emit(sessionId, type, data);

const collect = () => {
  const msgs: WireMsg[] = [];
  return { msgs, send: (m: WireMsg) => (msgs.push(m), true) };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const terms = () => (terminalPool as any).terms as Map<string, any>;
const fakeTerm = (over: Record<string, unknown> = {}) => ({
  pty: { kill: vi.fn(), write: vi.fn(), resize: vi.fn() },
  output: "prompt$ ",
  outputBytes: 8,
  baseOffset: 0,
  truncated: false,
  exitCode: null,
  signal: null,
  exited: false,
  exitedAt: null,
  waiters: [],
  outputByteLimit: 1024,
  listeners: new Set(),
  eventListeners: new Set(),
  inputSeq: new Map(),
  viewers: [],
  sessionId: "s",
  cwd: "/tmp",
  label: "sh",
  createdAt: Date.now(),
  user: true,
  lastActivity: Date.now(),
  ...over,
});

describe("multiplexed stream connections", () => {
  it("terminal sub delivers an atomic snapshot then live data with offsets", async () => {
    terms().set("t-mux", fakeTerm());
    const c = conn();
    subscribe(c, [{ kind: "terminal", id: "t-mux" }]);
    const { msgs, send } = collect();
    attachStream(c, 0, send);
    // attach resolves on a microtask even in local mode (MaybePromise surface)
    await Promise.resolve();

    const snap = msgs.find((m) => m.kind === "terminal" && m.snapshot != null);
    expect(snap).toMatchObject({ snapshot: "prompt$ ", offset: 0, end: 8 });

    // simulate live pty output
    const e = terms().get("t-mux")!;
    e.output += "hello";
    e.outputBytes += 5;
    for (const fn of e.listeners as Set<(d: string, off: number) => void>) fn("hello", 13);
    const data = msgs.find((m) => m.kind === "terminal" && m.data != null);
    expect(data).toMatchObject({ data: "hello", offset: 13 });

    unsubscribe(c, [{ kind: "terminal", id: "t-mux" }]);
    expect(terms().get("t-mux")!.listeners.size).toBe(0);
    detachStream(c);
    terms().delete("t-mux");
  });

  it("terminal resync sends only the tail the cursor missed", async () => {
    const e = fakeTerm();
    terms().set("t-mux2", e);
    const c = conn();
    subscribe(c, [{ kind: "terminal", id: "t-mux2" }]);
    const { msgs: first, send } = collect();
    attachStream(c, 0, send);
    await Promise.resolve();
    const lastN = first[first.length - 1].n; // the client received the full snapshot
    detachStream(c);

    // output while detached: 5 bytes at offsets 8..13
    e.output += "WORLD";
    e.outputBytes += 5;
    const { msgs, send: send2 } = collect();
    attachStream(c, lastN, send2);
    await Promise.resolve();
    const snap = msgs.find((m) => m.kind === "terminal" && typeof m.snapshot === "string");
    // partial: the client must append this tail, not replace its scrollback
    expect(snap).toMatchObject({ snapshot: "WORLD", offset: 8, end: 13, partial: true });
    detachStream(c);
    terms().delete("t-mux2");
  });

  it("detached connections are GC'd after the TTL and their subs released", () => {
    vi.useFakeTimers();
    try {
      const e = fakeTerm();
      terms().set("t-mux3", e);
      const c = conn();
      subscribe(c, [{ kind: "terminal", id: "t-mux3" }]);
      attachStream(c, 0, () => true);
      detachStream(c);
      expect(connectionInfo(c)).not.toBeNull();
      vi.advanceTimersByTime(61_000);
      expect(connectionInfo(c)).toBeNull();
      expect(e.listeners.size).toBe(0);
      terms().delete("t-mux3");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reconnect cursor rewind (round 2)", () => {
  it("keeps only global messages in the outbox", () => {
    const c = conn();
    subscribe(c, [{ kind: "view", id: "s-rw3" }]);
    emit("s-rw3", "session_update", { sessionUpdate: "session_info_update", title: "one" });
    expect(connectionInfo(c)!.outbox).toBe(0);
    detachStream(c);
  });

  it("treats a Last-Event-ID from another server process as 'nothing seen'", () => {
    const c = conn();
    subscribe(c, [{ kind: "view", id: "s-rw4" }]);
    emit("s-rw4", "session_update", { sessionUpdate: "session_info_update", title: "one" });
    const re: WireMsg[] = [];
    attachStream(c, 999_999, (m) => (re.push(m), true));
    expect(
        re.filter((m) => m.kind === "view" && (m.view as ViewFrame).t === "snapshot"))
        .toHaveLength(1);
    detachStream(c);
  });

  it("garbage-collects a connection that subscribed but never attached a stream", () => {
    vi.useFakeTimers();
    try {
      const c = conn();
      subscribe(c, [{ kind: "view", id: "s-rw5" }]);
      expect(connectionInfo(c)).not.toBeNull();
      vi.advanceTimersByTime(61_000);
      expect(connectionInfo(c)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("rewindCursor", () => {
  type Ack = { n: number; end: number };
  type Sub = { cursor: number; initial: number; acks: Ack[]; floor: Ack | null };
  const sub = (over: Partial<Sub> = {}): Sub => ({
    cursor: 30,
    initial: 5,
    acks: [
      { n: 1, end: 10 },
      { n: 2, end: 20 },
      { n: 3, end: 30 },
    ],
    floor: null,
    ...over,
  });

  it("moves back to the last acknowledged position", () => {
    const s = sub();
    rewindCursor(s, 2);
    expect(s.cursor).toBe(20);
    expect(s.acks.map((a) => a.n)).toEqual([1, 2]);
  });

  it("keeps the cursor when everything was received", () => {
    const s = sub();
    rewindCursor(s, 3);
    expect(s.cursor).toBe(30);
  });

  it("falls back to the trimmed floor, then to the initial cursor", () => {
    const a = sub({ floor: { n: 0, end: 7 }, acks: [{ n: 4, end: 40 }] });
    rewindCursor(a, 0);
    expect(a.cursor).toBe(7);
    const b = sub({ floor: { n: 9, end: 7 }, acks: [] });
    rewindCursor(b, 3);
    expect(b.cursor).toBe(5);
  });
});

describe("stale stream detach", () => {
  const liveSessionMsgs = (msgs: WireMsg[], from: number) =>
    msgs.slice(from).filter((m) => m.kind === "view" && (m.view as ViewFrame).t === "patch");

  it("a late abort from a superseded stream does not orphan the live one", () => {
    const c = conn();
    subscribe(c, [{ kind: "view", id: "s-a1" }]);
    const old = collect();
    const cur = collect();
    attachStream(c, 0, old.send);
    attachStream(c, 0, cur.send); // EventSource reconnect on a new socket
    detachStream(c, old.send); // the old request's abort lands late
    const before = cur.msgs.length;
    emit("s-a1", "session_state", { running: true });
    expect(liveSessionMsgs(cur.msgs, before)).toHaveLength(1);
    detachStream(c, cur.send);
  });

  it("three reconnects with aborts arriving in reverse order keep the newest stream", () => {
    const c = conn();
    subscribe(c, [{ kind: "view", id: "s-a1b" }]);
    const s1 = collect();
    const s2 = collect();
    const s3 = collect();
    attachStream(c, 0, s1.send);
    attachStream(c, 0, s2.send);
    attachStream(c, 0, s3.send);
    detachStream(c, s2.send);
    detachStream(c, s1.send);
    const before = s3.msgs.length;
    emit("s-a1b", "session_state", { running: true });
    expect(liveSessionMsgs(s3.msgs, before)).toHaveLength(1);
    detachStream(c, s3.send);
  });

  it("detaching the current stream still releases it", () => {
    const c = conn();
    subscribe(c, [{ kind: "view", id: "s-a1c" }]);
    const s = collect();
    attachStream(c, 0, s.send);
    detachStream(c, s.send);
    const before = s.msgs.length;
    emit("s-a1c", "session_state", { running: true });
    expect(s.msgs.length).toBe(before);
  });
});

describe("failed stream cleanup", () => {
  it("releases subscriptions when delivery failed before the stream aborts", () => {
    vi.useFakeTimers();
    const c = conn();
    const sid = "s-failed-abort";
    let alive = true;
    const send = () => alive;
    try {
      subscribe(c, [{ kind: "view", id: sid }]);
      attachStream(c, 0, send);
      alive = false;
      emit(sid, "session_state", { running: true });
      // deliver has already cleared c.send; the matching HTTP abort must
      // still start the disconnected connection's cleanup grace period.
      detachStream(c, send);
      vi.advanceTimersByTime(60_001);
      expect(connectionInfo(c)).toBeNull();
    } finally {
      unsubscribe(c, [{ kind: "view", id: sid }]);
      detachStream(c);
      vi.advanceTimersByTime(60_001);
      vi.useRealTimers();
    }
  });
});

describe("view subscriptions (D V2-1)", () => {
  const views = (msgs: WireMsg[]) =>
    msgs.filter((m) => m.kind === "view").map((m) => m.view as ViewFrame);

  it("a fresh view sub gets one snapshot carrying the current meta", () => {
    const sid = "v2-a";
    manager().view.setMeta(sid, { title: "hello" });
    const c = conn();
    const { msgs, send } = collect();
    attachStream(c, 0, send);
    subscribe(c, [{ kind: "view", id: sid }]);
    const v = views(msgs);
    expect(v[0]).toMatchObject({ t: "snapshot", meta: { title: "hello" } });
    expect(v[0].v).toBeGreaterThan(0);
    expect(v.slice(1).map((f) => f.v)).toEqual([v[0].v + 1]);
    expect(v.at(-1)?.meta?.watchers).toBe(1);
    // after the snapshot only patches follow (the watcher count is one)
    expect(v.slice(1).every((f) => f.t === "patch")).toBe(true);
    detachStream(c, send);
  });

  it("a reconnect inside the log gets only the missed patches", () => {
    const sid = "v2-b";
    const c = conn();
    const first = collect();
    attachStream(c, 0, first.send);
    subscribe(c, [{ kind: "view", id: sid }]);
    manager().view.setMeta(sid, { title: "1" });
    const seen = manager().view.version(sid); // delivered → the sub's cursor
    const lastN = first.msgs.at(-1)!.n;
    detachStream(c, first.send); // (the watcher-count patch this emits is missed too)
    manager().view.setMeta(sid, { title: "2" });
    manager().view.setMeta(sid, { title: "3" });
    const again = collect();
    attachStream(c, lastN, again.send);
    const v = views(again.msgs);
    expect(v.every((f) => f.t === "patch")).toBe(true); // no snapshot
    const vs = v.map((f) => f.v);
    expect(vs[0]).toBe(seen + 1);
    expect(vs).toEqual(vs.map((_, i) => vs[0] + i)); // contiguous
    expect(v.some((f) => f.meta?.title === "3")).toBe(true);
    detachStream(c, again.send);
  });

  it("a reconnect beyond the log gets a snapshot instead", () => {
    const sid = "v2-c";
    const c = conn();
    const first = collect();
    attachStream(c, 0, first.send);
    subscribe(c, [{ kind: "view", id: sid }]);
    manager().view.setMeta(sid, { title: "0" });
    const lastN = first.msgs.at(-1)!.n;
    detachStream(c, first.send);
    for (let i = 1; i <= 300; i++) manager().view.setMeta(sid, { title: `${i}` });
    const again = collect();
    attachStream(c, lastN, again.send);
    const v = views(again.msgs);
    expect(v[0]).toMatchObject({ t: "snapshot", meta: { title: "300" } });
    expect(v.slice(1).every((f) => f.t === "patch")).toBe(true);
    detachStream(c, again.send);
  });

  it("the watcher count reaches view subscribers as meta", () => {
    const sid = "v2-e";
    const a = conn();
    const b = conn();
    const ca = collect();
    const cb = collect();
    attachStream(a, 0, ca.send);
    attachStream(b, 0, cb.send);
    subscribe(a, [{ kind: "view", id: sid }]);
    subscribe(b, [{ kind: "view", id: sid }]);
    expect(manager().view.meta(sid).watchers).toBe(2);
    expect(views(ca.msgs).some((f) => f.meta?.watchers === 2)).toBe(true);
    detachStream(a, ca.send);
    detachStream(b, cb.send);
  });
});

describe("view lifecycle and route (D V2-1)", () => {
  const views = (msgs: WireMsg[]) => msgs.filter((m) => m.kind === "view").map((m) => m.view as ViewFrame);
  const specs = (id: string) => [{ kind: "view" as const, id }];

  it("hydrates running runtime state before sending the first snapshot", () => {
    const sid = "v2-hydrate";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = (manager() as any).sessions;
    sessions.set(sid, { sessionId: sid, running: true, queue: [], cwd: "/tmp", loaded: true });
    const c = conn();
    const out = collect();
    try {
      attachStream(c, 0, out.send);
      subscribe(c, specs(sid));
      const frames = views(out.msgs);
      expect(frames[0]).toMatchObject({ t: "snapshot", meta: { running: true } });
      expect(frames.filter((f) => f.t === "snapshot")).toHaveLength(1);
      expect(frames.slice(1).map((f) => f.v)).toEqual([frames[0].v + 1]);
    } finally {
      sessions.delete(sid);
      detachStream(c, out.send);
      unsubscribe(c, specs(sid));
    }
  });

  it("rewinds view ACKs to the client's last received frame", () => {
    const sid = "v2-ack";
    const c = conn();
    const first = collect();
    attachStream(c, 0, first.send);
    subscribe(c, specs(sid));
    const seen = first.msgs.at(-1)!.n;
    const baseline = manager().view.version(sid);
    manager().view.setMeta(sid, { title: "accepted but lost" });
    const again = collect();
    attachStream(c, seen, again.send);
    expect(views(again.msgs)).toEqual([{ t: "patch", v: baseline + 1, meta: { title: "accepted but lost" } }]);
    detachStream(c, again.send);
  });

  it("counts duplicate view subscriptions once and keeps the other viewer live", () => {
    const sid = "v2-mixed-watchers";
    const a = conn();
    const b = conn();
    const ca = collect();
    const cb = collect();
    attachStream(a, 0, ca.send);
    attachStream(b, 0, cb.send);
    subscribe(a, specs(sid));
    subscribe(a, specs(sid));
    subscribe(b, specs(sid));
    expect(manager().view.meta(sid).watchers).toBe(2);
    unsubscribe(a, specs(sid));
    expect(manager().view.meta(sid).watchers).toBe(1);
    expect(views(cb.msgs).at(-1)?.meta?.watchers).toBe(1);
    detachStream(b, cb.send);
    expect(manager().view.meta(sid).watchers).toBe(0);
    detachStream(a, ca.send);
  });

  it.each(["title", "region"])("a failed first viewer cannot reorder the %s update and watcher decrement for another viewer", (kind) => {
    const sid = `v2-reentrant-${kind}`;
    const m = manager();
    const a = conn();
    const b = conn();
    let alive = true;
    const failedSend = () => alive;
    const healthy = collect();
    try {
      attachStream(a, 0, failedSend);
      attachStream(b, 0, healthy.send);
      subscribe(a, specs(sid));
      subscribe(b, specs(sid));
      const base = m.view.version(sid);
      const before = healthy.msgs.length;
      alive = false;
      const item: AssembledItem = { id: "region-text", kind: "text", role: "agent", text: "live text",
        done: false, seqFrom: 1, seqTo: 1 };
      if (kind === "title") m.view.setMeta(sid, { title: "original update" });
      else m.view.regions(sid, { provisional: [item], durableThrough: 0 });
      const update = kind === "title"
        ? { meta: { title: "original update" } }
        : { prov: { order: [item.id], upsert: [item] } };
      const live = healthy.msgs.slice(before);
      expect(views(live)).toEqual([
        { t: "patch", v: base + 1, ...update },
        { t: "patch", v: base + 2, meta: { watchers: 1 } },
      ]);
      // A reconnect acknowledging only the original patch must replay the
      // watcher decrement, not skip the original update behind a newer ACK.
      const again = collect();
      attachStream(b, live[0].n, again.send);
      expect(views(again.msgs)).toEqual([{ t: "patch", v: base + 2, meta: { watchers: 1 } }]);
    } finally {
      detachStream(a);
      detachStream(b);
      unsubscribe(a, specs(sid));
      unsubscribe(b, specs(sid));
    }
  });

  it("failed delivery removes a view watcher and its subscription expires after abort", () => {
    vi.useFakeTimers();
    const sid = "v2-failed-send";
    const c = conn();
    let live = true;
    const send = () => live;
    try {
      attachStream(c, 0, send);
      subscribe(c, specs(sid));
      expect(manager().view.meta(sid).watchers).toBe(1);
      live = false;
      manager().view.setMeta(sid, { title: "fail" });
      expect(manager().view.meta(sid).watchers).toBe(0);
      detachStream(c, send);
      vi.advanceTimersByTime(60_001);
      expect(connectionInfo(c)).toBeNull();
    } finally {
      unsubscribe(c, specs(sid));
      vi.useRealTimers();
    }
  });

  it.each([false, true])("delete then recreate clears old ACKs and their floor (disconnected=%s)", async (disconnected) => {
    const sid = `v2-delete-${disconnected}`;
    const m = manager();
    const ensure = vi.spyOn(m, "ensure").mockImplementation(async () => ({} as Awaited<ReturnType<typeof m.ensure>>));
    const request = vi.spyOn(m.bridge, "request").mockResolvedValue({});
    const c = conn();
    const first = collect();
    const again = collect();
    try {
      attachStream(c, 0, first.send);
      subscribe(c, specs(sid));
      // Fill the ACK cap so a stale floor can resurrect the prior generation.
      for (let i = 0; i < 1030; i++) m.view.setMeta(sid, { title: `old-${i}` });
      const oldVersion = m.view.version(sid);
      const oldN = first.msgs.at(-1)!.n;
      if (disconnected) detachStream(c, first.send);
      const beforeDelete = first.msgs.length;
      await m.deleteSession(sid);
      if (!disconnected) expect(views(first.msgs.slice(beforeDelete))).toEqual([
        expect.objectContaining({ t: "snapshot", v: 0, durable: [], provisional: [], retained: [] }),
      ]);
      else expect(first.msgs).toHaveLength(beforeDelete);
      // Equal old/new versions cannot distinguish generations by comparison.
      for (let i = 1; i <= oldVersion; i++) m.view.setMeta(sid, { title: `new-${i}` });
      expect(m.view.version(sid)).toBe(oldVersion);
      attachStream(c, oldN, again.send);
      expect(views(again.msgs)[0]).toMatchObject({ t: "snapshot", meta: { title: `new-${oldVersion}` } });
      expect(views(again.msgs).slice(1).every((f) => f.t === "patch")).toBe(true);
    } finally {
      ensure.mockRestore();
      request.mockRestore();
      detachStream(c);
      unsubscribe(c, specs(sid));
    }
  });

  it("records lower versions after a live v0 reset", async () => {
    const sid = "v2-reset-ack";
    const m = manager();
    const ensure = vi.spyOn(m, "ensure").mockImplementation(async () => ({} as Awaited<ReturnType<typeof m.ensure>>));
    const request = vi.spyOn(m.bridge, "request").mockResolvedValue({});
    const c = conn();
    const first = collect();
    const again = collect();
    try {
      attachStream(c, 0, first.send);
      subscribe(c, specs(sid));
      for (let i = 0; i < 5; i++) m.view.setMeta(sid, { title: `old-${i}` });
      await m.deleteSession(sid);
      emit(sid, "session_update", { sessionUpdate: "session_info_update", title: "new-1" });
      const seen = first.msgs.at(-1)!.n;
      m.view.setMeta(sid, { title: "new-2" });
      attachStream(c, seen, again.send);
      expect(views(again.msgs)).toEqual([
        { t: "patch", v: 2, meta: { title: "new-2" } },
        { t: "patch", v: 3, meta: { watchers: 1 } },
      ]);
    } finally {
      ensure.mockRestore();
      request.mockRestore();
      detachStream(c);
      unsubscribe(c, specs(sid));
    }
  });

  it("a refused delete preserves the view generation and replay cursor", async () => {
    const sid = "v2-refused-delete";
    const m = manager();
    const ensure = vi.spyOn(m, "ensure").mockImplementation(async () => ({} as Awaited<ReturnType<typeof m.ensure>>));
    const request = vi.spyOn(m.bridge, "request").mockRejectedValue(new Error("refused"));
    const c = conn();
    const first = collect();
    const again = collect();
    try {
      attachStream(c, 0, first.send);
      subscribe(c, specs(sid));
      const seen = first.msgs.at(-1)!.n;
      const baseline = m.view.version(sid);
      const before = first.msgs.length;
      await expect(m.deleteSession(sid)).rejects.toThrow("refused");
      expect(first.msgs).toHaveLength(before);
      m.view.setMeta(sid, { title: "still here" });
      attachStream(c, seen, again.send);
      expect(views(again.msgs)).toEqual([{ t: "patch", v: baseline + 1, meta: { title: "still here" } }]);
    } finally {
      ensure.mockRestore();
      request.mockRestore();
      detachStream(c);
      unsubscribe(c, specs(sid));
    }
  });

  it("snapshot preparation is covered for the resyncing viewer and remains live for other viewers", () => {
    const sid = "v2-snapshot-prepare";
    const m = manager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = (m as any).sessions;
    const a = conn();
    const b = conn();
    const first = collect();
    const other = collect();
    const again = collect();
    try {
      attachStream(a, 0, first.send);
      attachStream(b, 0, other.send);
      subscribe(a, specs(sid));
      subscribe(b, specs(sid));
      const seen = first.msgs.at(-1)!.n;
      detachStream(a, first.send);
      for (let i = 0; i < 300; i++) m.view.setMeta(sid, { title: `${i}` });
      sessions.set(sid, { sessionId: sid, running: true, queue: [], cwd: "/tmp", loaded: true });
      const beforeOther = other.msgs.length;
      attachStream(a, seen, again.send);
      const frames = views(again.msgs);
      expect(frames[0]).toMatchObject({ t: "snapshot", meta: { running: true, title: "299" } });
      expect(views(other.msgs.slice(beforeOther))).toContainEqual(expect.objectContaining({ t: "patch", meta: expect.objectContaining({ running: true }) }));
      m.view.setMeta(sid, { title: "after snapshot" });
      expect(views(again.msgs).slice(1).map((f) => f.v)).toEqual([frames[0].v + 1, frames[0].v + 2]);
      const snapshotN = again.msgs.find((msg) => (msg.view as ViewFrame)?.t === "snapshot")!.n;
      const replay = collect();
      attachStream(a, snapshotN, replay.send);
      expect(views(replay.msgs)).toEqual(views(again.msgs).slice(1));
    } finally {
      sessions.delete(sid);
      detachStream(a);
      detachStream(b);
      unsubscribe(a, specs(sid));
      unsubscribe(b, specs(sid));
    }
  });

  it("a failed snapshot read does not leave live patches suppressed", () => {
    const sid = "v2-snapshot-throw";
    const c = conn();
    const first = collect();
    const again = collect();
    attachStream(c, 0, first.send);
    subscribe(c, specs(sid));
    const snapshot = vi.spyOn(manager(), "viewSnapshot").mockImplementationOnce(() => { throw new Error("snapshot unavailable"); });
    try {
      expect(() => attachStream(c, 0, again.send)).toThrow("snapshot unavailable");
      const baseline = manager().view.version(sid);
      manager().view.setMeta(sid, { title: "live after failure" });
      expect(views(again.msgs)).toEqual([{ t: "patch", v: baseline + 1, meta: { title: "live after failure" } }]);
    } finally {
      snapshot.mockRestore();
      detachStream(c);
      unsubscribe(c, specs(sid));
    }
  });

  it("the subscribe route accepts view add/remove and filters removed and unknown kinds", async () => {
    const sid = "v2-route";
    const c = conn();
    const out = collect();
    attachStream(c, 0, out.send);
    const post = (body: unknown) => subscribeRoute(new NextRequest("http://localhost/api/stream/subscribe", {
      method: "POST", body: JSON.stringify({ connId: c, ...body as object }),
    }));
    try {
      expect((await post({ add: [...specs(sid), { kind: "bogus", id: sid }, { kind: "session", id: sid }] })).status).toBe(200);
      expect(connectionInfo(c)?.subs).toEqual([`view:${sid}`]);
      expect(views(out.msgs)[0]).toMatchObject({ t: "snapshot" });
      expect((await post({ remove: specs(sid) })).status).toBe(200);
      expect(connectionInfo(c)?.subs).toEqual([]);
      const before = out.msgs.length;
      manager().view.setMeta(sid, { title: "unsubscribed" });
      expect(out.msgs).toHaveLength(before);
    } finally {
      detachStream(c, out.send);
      unsubscribe(c, specs(sid));
    }
  });
});

describe("surviving global outbox", () => {
  it("bounds global history at 512 and reconnects only beyond the acknowledged wire id", () => {
    const c = conn();
    subscribe(c, [{ kind: "global" }, { kind: "view", id: "global-outbox" }]);
    const first = collect();
    attachStream(c, 0, first.send);
    const seen = first.msgs.at(-1)!.n;
    detachStream(c, first.send);
    for (let i = 0; i < 600; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager() as any).broadcastGlobal({ type: "sessions_changed", data: { i } });
    }
    manager().view.setMeta("global-outbox", { title: "outside global history" });
    expect(connectionInfo(c)?.outbox).toBe(512);
    const again = collect();
    attachStream(c, seen, again.send);
    const global = again.msgs.filter((m) => m.kind === "global");
    expect(global.map((m) => (m.ev as { data: { i: number } }).data.i)).toEqual(Array.from({ length: 512 }, (_, i) => i + 88));
    const final = collect();
    attachStream(c, global.at(-2)!.n, final.send);
    expect(final.msgs.filter((m) => m.kind === "global")).toEqual([global.at(-1)]);
    unsubscribe(c, [{ kind: "global" }, { kind: "view", id: "global-outbox" }]);
    detachStream(c);
  });
});

describe("transcript delta fan-out", () => {
  it("shares one sessions.db handle per commit across subscribers", async () => {
    const sid = "s-fanout";
    const dbMod = await import("../lib/db");
    const { pokeSessionsDb } = await import("../lib/transcriptWatch");
    const spy = vi.spyOn(dbMod, "openSessionsDb");
    const c1 = conn();
    const c2 = conn();
    const c3 = conn();
    const m1 = collect();
    const m2 = collect();
    const m3 = collect();
    try {
      attachStream(c1, 0, m1.send);
      attachStream(c2, 0, m2.send);
      attachStream(c3, 0, m3.send);
      subscribe(c1, [{ kind: "transcript", id: sid }]);
      subscribe(c2, [{ kind: "transcript", id: sid }]);
      subscribe(c3, [{ kind: "transcript", id: sid }]);

      // openSessionsDb is read-only — write the fixture commit directly
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(stateDir, "sessions.db"));
      try {
        db.prepare(
          "INSERT INTO message_nodes (session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,1,NULL,?,?)",
        ).run(
          sid,
          JSON.stringify({ role: "assistant", message_id: "fanout-1", content: "fanout hello" }),
          1_700_000_000,
        );
      } finally {
        db.close();
      }

      spy.mockClear();
      pokeSessionsDb();
      await new Promise((r) => setTimeout(r, 150)); // past the 60ms debounce

      const deltas = (msgs: WireMsg[]) =>
        msgs.filter((m) => m.kind === "transcript" && m.type === "items");
      const d1 = deltas(m1.msgs);
      const d2 = deltas(m2.msgs);
      const d3 = deltas(m3.msgs);
      expect(d1).toHaveLength(1);
      expect(d2).toHaveLength(1);
      expect(d3).toHaveLength(1);
      expect((d1[0] as { items?: { text?: string }[] }).items?.[0]?.text).toBe(
        "fanout hello",
      );
      // ≤2: the shared fan-out scan plus at most one watermark cache refill —
      // before the shared handle it was one open per subscriber (3+ here)
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      spy.mockRestore();
      unsubscribe(c1, [{ kind: "transcript", id: sid }]);
      unsubscribe(c2, [{ kind: "transcript", id: sid }]);
      unsubscribe(c3, [{ kind: "transcript", id: sid }]);
      detachStream(c1);
      detachStream(c2);
      detachStream(c3);
    }
  });
});

describe("push visibility gate", () => {
  it("a session counts as seen only through a live, visible view", async () => {
    const c = conn();
    const { send } = collect();
    attachStream(c, 0, send, false); // tab connected while hidden
    subscribe(c, [{ kind: "view", id: "pv1" }]);
    expect(sessionSeen("pv1")).toBe(false);
    await subscribeRoute(
      new NextRequest("http://127.0.0.1/api/stream/subscribe", {
        method: "POST",
        body: JSON.stringify({ connId: c, visible: true }),
      }),
    );
    expect(sessionSeen("pv1")).toBe(true);
    expect(sessionSeen("other")).toBe(false);
    detachStream(c, send);
    expect(sessionSeen("pv1")).toBe(false);
  });
});
