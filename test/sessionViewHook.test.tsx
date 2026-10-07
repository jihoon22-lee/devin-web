// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ViewFrame } from "../lib/acp/sessionView";
import { emptySessionState } from "../lib/client/model";
import type { useSessionView as Hook } from "../hooks/useSessionView";

class FakeES {
  static CLOSED = 2;
  static all: FakeES[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: { data: string; lastEventId: string }) => void) | null = null;
  constructor(public url: string) { FakeES.all.push(this); }
  close() { this.readyState = FakeES.CLOSED; }
  open() { this.readyState = 1; this.onopen?.(); }
  msg(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj), lastEventId: "" }); }
  fail(permanent = false) { this.readyState = permanent ? 2 : 0; this.onerror?.(); }
}
type Spec = { kind: string; id: string };
type Post = { add: Spec[]; remove: Spec[] };
const snapshot = (v = 1, title = "A"): Extract<ViewFrame, { t: "snapshot" }> => ({
  t: "snapshot", v, meta: { ...emptySessionState(), title },
  durable: [{ id: 10, role: "assistant", text: "ten", ts: 1 }],
  durableTruncated: true, provisional: [], retained: [], durableThrough: 10,
});
let useSessionView: typeof Hook;
let stream: typeof import("../lib/client/stream");
let posts: Post[];
let serverSubs: Set<string>;
let serverView: ViewFrame;
let failPosts: number;
let networkFailure: boolean;
let loseResponse: boolean;
let gatePost: (() => Promise<void>) | undefined;
let page: Promise<unknown>;
let requestedPages: number;
let stopped: (() => void)[];
const source = () => FakeES.all.at(-1)!;
const flush = async (ms = 40) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const send = (view: ViewFrame, sid = "A") => act(() => source().msg({ kind: "view", id: sid, view }));
const connect = (epoch = "one") => act(() => {
  source().open(); source().msg({ kind: "meta", type: "ready", epoch });
});

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); FakeES.all = [];
  posts = []; serverSubs = new Set(); serverView = snapshot(); failPosts = 0; networkFailure = false; loseResponse = false;
  gatePost = undefined; page = Promise.resolve({ items: [] }); requestedPages = 0; stopped = [];
  vi.stubGlobal("EventSource", FakeES);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/stream/subscribe") {
      const post: Post = JSON.parse(init!.body as string); posts.push(post);
      const gate = gatePost; gatePost = undefined;
      if (gate) await gate();
      if (failPosts > 0) {
        failPosts--;
        if (networkFailure) throw new Error("network unreachable");
        return { ok: false, status: 503 };
      }
      // The server retains topics across reconnect/remount and only a new
      // subscription emits a snapshot. Re-adding an existing topic is a no-op.
      for (const s of post.remove) serverSubs.delete(`${s.kind}:${s.id}`);
      for (const s of post.add) {
        const key = `${s.kind}:${s.id}`;
        if (serverSubs.has(key)) continue;
        serverSubs.add(key);
        if (s.kind === "view" && source().readyState === 1) {
          source().msg({ kind: "view", id: s.id, view: serverView });
        }
      }
      if (loseResponse) { loseResponse = false; throw new Error("network lost response"); }
      return { ok: true, status: 200 };
    }
    if (path.includes("/transcript?")) {
      requestedPages++;
      return { ok: true, json: async () => await page };
    }
    return { ok: true, status: 200 };
  }));
  ({ useSessionView } = await import("../hooks/useSessionView"));
  stream = await import("../lib/client/stream");
});
afterEach(async () => {
  cleanup(); for (const stop of stopped) stop();
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it("renders a snapshot, contiguous patches and durable deltas with watermark clamping", async () => {
  const { result } = renderHook(() => useSessionView("A")); connect(); await flush();
  expect(result.current.connected).toBe(true);
  send({ t: "patch", v: 2, meta: { title: "two" } });
  act(() => source().msg({ kind: "transcript", id: "A", items: [
    { id: 9, role: "assistant", text: "nine", ts: 1 },
    { id: 11, role: "assistant", text: "eleven", ts: 1 },
  ] }));
  await flush();
  expect(result.current.state.title).toBe("two");
  expect(result.current.state.durable?.map(i => i.id)).toEqual(["bf-10", "bf-9"]);
});

it.each(["HTTP", "network"])("coalesces gaps and repairs a failed %s response without another frame", async (failure) => {
  networkFailure = failure === "network";
  const { result } = renderHook(() => useSessionView("A")); connect(); await flush();
  const before = posts.length;
  failPosts = 1; serverView = snapshot(8, "repaired");
  send({ t: "patch", v: 5, meta: { title: "bad" } });
  send({ t: "patch", v: 6, meta: { title: "also bad" } });
  await flush(0);
  expect(result.current.state.title).toBe("A");
  expect(posts.length - before).toBe(1);
  await flush(5000);
  expect(result.current.state.title).toBe("repaired");
  expect(posts.length - before).toBe(2);
});

it("bounds failed repair retries and re-arms on reconnect", async () => {
  const { result } = renderHook(() => useSessionView("A")); connect(); await flush();
  failPosts = 100;
  send({ t: "patch", v: 5, meta: { title: "bad" } });
  await flush(30_000); const count = posts.length;
  expect(count).toBeLessThanOrEqual(6);
  await flush(30_000); expect(posts).toHaveLength(count);
  failPosts = 0; serverView = snapshot(9, "after reconnect");
  act(() => source().fail()); connect(); await flush();
  expect(result.current.state.title).toBe("after reconnect");
});

it("cancels repair retries on unmount and ignores a resubscribe for an unowned topic", async () => {
  const { unmount } = renderHook(() => useSessionView("A")); connect(); await flush();
  failPosts = 1; send({ t: "patch", v: 5 }); await flush(0);
  unmount(); await flush(0); const count = posts.length;
  await stream.resubscribe("view", "A"); await flush(30_000);
  expect(posts).toHaveLength(count);
  expect(serverSubs.has("view:A")).toBe(false);
});

it.each(["ready", "not-ready", "disconnected"])("fresh reducer receives a snapshot over a retained %s server topic", async (state) => {
  // Another mounted consumer keeps the server topic and its cursor alive.
  stopped.push(stream.streamSub("view", "A", () => {}));
  connect(); await flush();
  if (state !== "ready") act(() => source().fail());
  if (state === "not-ready") act(() => source().open());
  serverView = snapshot(4, "fresh");
  const { result } = renderHook(() => useSessionView("A"));
  if (state !== "ready") connect();
  await flush();
  expect(result.current.state.title).toBe("fresh");
  expect(result.current.state.v).toBe(4);
});

it("serializes a fast A→B→A remount against an in-flight subscription change", async () => {
  const { result, rerender } = renderHook(({ sid }) => useSessionView(sid), { initialProps: { sid: "A" } });
  connect(); await flush();
  let release!: () => void;
  gatePost = () => new Promise<void>(r => { release = r; });
  stopped.push(stream.streamSub("global", "", () => {}));
  const pendingCount = posts.length;
  rerender({ sid: "B" }); rerender({ sid: "A" });
  expect(posts).toHaveLength(pendingCount);
  serverView = snapshot(3, "A remounted");
  await act(async () => release()); await flush();
  expect(result.current.state.title).toBe("A remounted");
  expect(serverSubs.has("view:B")).toBe(false);
});

it("re-seeds every wanted view after a successful pre-ready POST retained its server topic", async () => {
  const a = renderHook(() => useSessionView("A"));
  const b = renderHook(() => useSessionView("B"));
  stopped.push(stream.streamSub("session", "legacy", () => {}));
  stopped.push(stream.streamSub("terminal", "term", () => {}));
  stopped.push(stream.streamSub("global", "", () => {}));
  connect(); await flush();
  expect(a.result.current.state.title).toBe("A");
  expect(b.result.current.state.title).toBe("A");

  let release!: () => void;
  gatePost = () => new Promise<void>(r => { release = r; });
  await stream.resubscribe("view", "A");
  act(() => source().fail());
  // The replacement process accepts the POST before its SSE is attached.
  // Its successful response consumes the force intent under the old epoch.
  serverSubs.clear(); serverView = snapshot(1, "replacement");
  await act(async () => release()); await flush();
  expect(serverSubs.has("view:A")).toBe(true);
  expect(serverSubs.has("view:B")).toBe(true);
  expect(a.result.current.state.title).toBe("A");
  const beforeReady = posts.length;

  act(() => {
    source().open();
    // attachStream resyncs retained subscriptions before the route writes ready.
    source().msg({ kind: "view", id: "A", view: serverView });
    source().msg({ kind: "view", id: "B", view: serverView });
    source().msg({ kind: "meta", type: "ready", epoch: "two" });
  });
  // No subsequent live patch: the ready reconciliation must supply snapshots.
  await flush(5000);
  expect(a.result.current.state.title).toBe("replacement");
  expect(b.result.current.state.title).toBe("replacement");
  expect(a.result.current.state.durable?.map(i => i.id)).toEqual(["bf-10"]);
  expect(b.result.current.state.durable?.map(i => i.id)).toEqual(["bf-10"]);
  expect(posts.slice(beforeReady)).toMatchObject([{
    add: [
      { kind: "view", id: "A" }, { kind: "transcript", id: "A" },
      { kind: "view", id: "B" }, { kind: "transcript", id: "B" },
      { kind: "session", id: "legacy" }, { kind: "terminal", id: "term" },
      { kind: "global", id: "" },
    ],
    remove: [{ kind: "view", id: "A" }, { kind: "view", id: "B" }],
  }]);
});

it("retired EventSource callbacks cannot overwrite the active epoch or dispatch frames", async () => {
  const { result } = renderHook(() => useSessionView("A")); connect(); await flush();
  const old = source(); act(() => old.fail(true)); await flush(1000);
  serverSubs.clear(); serverView = snapshot(1, "new epoch"); connect("two"); await flush();
  act(() => {
    old.msg({ kind: "meta", type: "ready", epoch: "one" });
    old.msg({ kind: "view", id: "A", view: snapshot(99, "retired") });
    old.open(); old.fail();
  });
  await flush();
  expect(result.current.state.title).toBe("new epoch");
  expect(result.current.connected).toBe(true);
});

it.each(["switch", "restart", "snapshot", "unmount"])("drops older-page responses after %s", async (change) => {
  const duplicate = "stale page duplicate ".repeat(20);
  serverView = { ...snapshot(), durable: [{ id: 10, role: "assistant", text: duplicate, ts: 1 }] };
  const { result, rerender, unmount } = renderHook(({ sid }) => useSessionView(sid), { initialProps: { sid: "A" } });
  connect(); await flush();
  let release!: (v: unknown) => void;
  page = new Promise(r => { release = r; });
  let pending!: Promise<void>;
  act(() => { pending = result.current.loadOlder(); });
  expect(requestedPages).toBe(1);
  if (change === "switch") rerender({ sid: "B" });
  if (change === "restart") { serverSubs.clear(); serverView = snapshot(1, "new"); connect("two"); }
  if (change === "snapshot") send(snapshot(5, "new"));
  if (change === "unmount") unmount();
  await act(async () => { release({ items: [{ id: 2, role: "assistant", text: duplicate, ts: 1 }] }); await pending; });
  await flush();
  expect(result.current.state.durable?.some(i => i.id === "bf-2")).not.toBe(true);
  // React ignores publication after unmount, but a stale page would still
  // run the integrity alarm. Assert the observable side effect is absent.
  const alarms = vi.mocked(fetch).mock.calls.filter(([path, init]) =>
    path === "/api/diag" && JSON.parse(init!.body as string).t === "integrity");
  expect(alarms).toHaveLength(0);
});

it("keeps valid pagination across ordinary patches and ignores REST retained data", async () => {
  const { result } = renderHook(() => useSessionView("A")); connect(); await flush();
  let release!: (v: unknown) => void;
  page = new Promise(r => { release = r; });
  let pending!: Promise<void>;
  act(() => { pending = result.current.loadOlder(); });
  send({ t: "patch", v: 2, meta: { title: "streaming" }, retained: [] });
  await act(async () => {
    release({ items: [{ id: 2, role: "assistant", text: "older", ts: 1 }], truncated: false,
      retained: [{ id: "stale-thought", kind: "text", role: "thought", text: "stale", anchorNode: 2, seqFrom: 1, seqTo: 1 }] });
    await pending;
  });
  await flush();
  expect(result.current.state.durable?.map(i => i.id)).toEqual(["bf-2", "bf-10"]);
  expect(result.current.state.retained).toEqual([]);
  expect(result.current.state.title).toBe("streaming");
  expect(result.current.state.historyTruncated).toBe(false);
});


it("removes a retired topic even when its initial POST succeeded but the response was lost", async () => {
  let release!: () => void;
  gatePost = () => new Promise<void>(r => { release = r; });
  const { unmount } = renderHook(() => useSessionView("A"));
  connect();
  // A resubscribe caller must settle even while HTTP is pending and the
  // consumer goes away. The network gate remains closed until after await.
  await stream.resubscribe("view", "A");
  unmount(); loseResponse = true;
  await act(async () => release()); await flush();
  expect(serverSubs.has("view:A")).toBe(false);
  expect(serverSubs.has("transcript:A")).toBe(false);
});

it("does not deliver the previous session's late frames after a switch", async () => {
  const { result, rerender } = renderHook(({ sid }) => useSessionView(sid), { initialProps: { sid: "A" } });
  connect(); await flush();
  serverView = snapshot(1, "B"); rerender({ sid: "B" }); await flush();
  send(snapshot(99, "stale A")); await flush();
  expect(result.current.state.title).toBe("B");
});

it("renders new session patches after cancelling the old session's pending flush", async () => {
  const { result, rerender } = renderHook(({ sid }) => useSessionView(sid), { initialProps: { sid: "A" } });
  connect(); await flush();
  send({ t: "patch", v: 2, meta: { running: true } });
  serverView = snapshot(1, "B");
  rerender({ sid: "B" });
  await flush(0);
  send({ t: "patch", v: 2, meta: { running: true } }, "B");
  await flush();
  expect(result.current.state.title).toBe("B");
  expect(result.current.state.running).toBe(true);
  send({ t: "patch", v: 3, meta: { running: false } }, "B");
  await flush();
  expect(result.current.state.running).toBe(false);
});

it("drops a poisoned frame, reports it and continues from the last valid view", async () => {
  const { result } = renderHook(() => useSessionView("A")); connect(); await flush();
  send({ ...snapshot(2, "poisoned"), retained: null } as unknown as ViewFrame);
  await flush();
  expect(result.current.state.title).toBe("A");
  expect(result.current.state.v).toBe(1);
  expect(vi.mocked(fetch).mock.calls.some(([path, init]) =>
    path === "/api/diag" && JSON.parse(init!.body as string).t === "jsrej")).toBe(true);
  send({ t: "patch", v: 2, meta: { title: "recovered" } });
  await flush();
  expect(result.current.state.title).toBe("recovered");
});


it("preserves a repair whose pending HTTP request fails while disconnected", async () => {
  const { result } = renderHook(() => useSessionView("A")); connect(); await flush();
  let release!: () => void;
  gatePost = () => new Promise<void>(r => { release = r; });
  failPosts = 1;
  send({ t: "patch", v: 5 });
  act(() => source().fail());
  await act(async () => release()); await flush(5000);
  serverView = snapshot(6, "reconnected repair"); connect(); await flush();
  expect(result.current.state.title).toBe("reconnected repair");
});
