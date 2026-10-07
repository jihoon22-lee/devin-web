// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeES {
  static CLOSED = 2;
  static all: FakeES[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: { data: string; lastEventId: string }) => void) | null = null;
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  close() {
    this.readyState = FakeES.CLOSED;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  msg(obj: unknown, id = "") {
    this.onmessage?.({ data: JSON.stringify(obj), lastEventId: id });
  }
  fail(permanent: boolean) {
    if (permanent) this.readyState = FakeES.CLOSED;
    this.onerror?.();
  }
}

beforeEach(() => {
  vi.resetModules(); // lib/client/stream keeps module-level state
  FakeES.all = [];
  vi.stubGlobal("EventSource", FakeES);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("client stream", () => {
  it("fires onServerRestart only when the ready epoch changes", async () => {
    const s = await import("../lib/client/stream");
    const restarted = vi.fn();
    s.onServerRestart(restarted);
    s.streamSub("global", "", () => {});
    const es = FakeES.all[0];
    es.open();
    es.msg({ kind: "meta", type: "ready", epoch: "A" });
    es.fail(false);
    es.open();
    es.msg({ kind: "meta", type: "ready", epoch: "A" });
    expect(restarted).not.toHaveBeenCalled();
    es.fail(false);
    es.open();
    es.msg({ kind: "meta", type: "ready", epoch: "B" });
    expect(restarted).toHaveBeenCalledTimes(1);
  });

  it("re-creates a permanently closed EventSource, carrying the last event id", async () => {
    vi.useFakeTimers();
    const s = await import("../lib/client/stream");
    s.streamSub("global", "", () => {});
    const es = FakeES.all[0];
    es.open();
    es.msg({ kind: "global", n: 7, ev: {} }, "7");
    es.fail(true);
    expect(FakeES.all).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeES.all).toHaveLength(2);
    expect(FakeES.all[1].url).toContain("last=7");
  });

  it("does not re-create while the browser is auto-reconnecting", async () => {
    vi.useFakeTimers();
    const s = await import("../lib/client/stream");
    s.streamSub("global", "", () => {});
    FakeES.all[0].open();
    FakeES.all[0].fail(false);
    vi.advanceTimersByTime(30_000);
    expect(FakeES.all).toHaveLength(1);
  });
});

describe("terminal input serialization", () => {
  it("retains the chain until all queued batches finish", async () => {
    vi.useFakeTimers();
    const s = await import("../lib/client/stream");
    const posts: { data: string; seq: number; finish: () => void }[] = [];
    vi.stubGlobal("fetch", vi.fn((_path: string, init: { body: string }) => new Promise((resolve) => {
      const { data, seq } = JSON.parse(init.body);
      posts.push({ data, seq, finish: () => resolve({ ok: true }) });
    })));
    s.sendTerminalInput("t", "A");
    await vi.advanceTimersByTimeAsync(40);
    s.sendTerminalInput("t", "B");
    await vi.advanceTimersByTimeAsync(40);
    expect(posts.map((p) => p.data)).toEqual(["A"]);
    posts[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.map((p) => p.data)).toEqual(["A", "B"]);
    s.sendTerminalInput("t", "C");
    await vi.advanceTimersByTimeAsync(40);
    expect(posts.map((p) => p.data)).toEqual(["A", "B"]);
    posts[1].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.map((p) => p.data)).toEqual(["A", "B", "C"]);
    posts[2].finish();
    await vi.advanceTimersByTimeAsync(0);
    s.sendTerminalInput("t", "D");
    await vi.advanceTimersByTimeAsync(40);
    expect(posts.map((p) => p.seq)).toEqual([1, 2, 3, 4]);
    posts[3].finish();
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("subscription reconciliation", () => {
  it("removes the acknowledged old topic when wanted changes during a POST", async () => {
    const s = await import("../lib/client/stream");
    const requests: { add: { kind: string; id: string }[]; remove: { kind: string; id: string }[] }[] = [];
    let finish!: (value: { ok: boolean }) => void;
    vi.stubGlobal("fetch", vi.fn((path: string, init: { body: string }) => {
      if (path !== "/api/stream/subscribe") return Promise.resolve({ ok: true });
      requests.push(JSON.parse(init.body));
      return requests.length === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ ok: true });
    }));
    const removeA = s.streamSub("session", "A", () => {});
    FakeES.all[0].open();
    FakeES.all[0].msg({ kind: "meta", type: "ready", epoch: "one" });
    removeA();
    s.streamSub("session", "B", () => {});
    finish({ ok: true });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(requests).toHaveLength(2);
    expect(requests[1].add).toEqual([{ kind: "session", id: "B" }]);
    expect(requests[1].remove).toEqual([{ kind: "session", id: "A" }]);
  });

  it("ignores an old server's in-flight acknowledgement after an epoch change", async () => {
    const s = await import("../lib/client/stream");
    const requests: { remove: unknown[] }[] = [];
    let finish!: (value: { ok: boolean }) => void;
    vi.stubGlobal("fetch", vi.fn((path: string, init: { body: string }) => {
      if (path !== "/api/stream/subscribe") return Promise.resolve({ ok: true });
      requests.push(JSON.parse(init.body));
      return requests.length === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ ok: true });
    }));
    const removeA = s.streamSub("session", "A", () => {});
    const es = FakeES.all[0];
    es.open(); es.msg({ kind: "meta", type: "ready", epoch: "one" });
    removeA(); s.streamSub("session", "B", () => {});
    es.msg({ kind: "meta", type: "ready", epoch: "two" });
    finish({ ok: true });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(requests).toHaveLength(2);
    expect(requests[1].remove).toEqual([]);
  });
});

it.each(["resubscribe", "retry", "continuation"])(
  "contains reconciliation-finally failures from the detached %s trigger",
  async (trigger) => {
    const s = await import("../lib/client/stream");
    let failPosts = false;
    let finish: (() => void) | undefined;
    const post = vi.fn(async (path: string) => {
      if (path !== "/api/stream/subscribe") return { ok: true, status: 200 };
      if (!failPosts) return { ok: true, status: 200 };
      if (trigger === "continuation" && !finish) {
        await new Promise<void>((resolve) => { finish = resolve; });
      }
      return { ok: false, status: 503 };
    });
    vi.stubGlobal("fetch", post);
    const stop = s.streamSub("view", "A", () => {});
    const es = FakeES.all[0];
    es.open(); es.msg({ kind: "meta", type: "ready", epoch: "one" });
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Force the exception outside syncSubs' main try/catch: scheduling a
    // retry happens in finally. No global rejection suppression is installed;
    // Vitest also fails this test if the detached promise escapes unhandled.
    const schedule = globalThis.setTimeout;
    const failureDelay = trigger === "retry" ? 500 : 250;
    let thrown = false;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => {
      if (ms === failureDelay && !thrown) {
        thrown = true;
        throw new Error("controlled retry scheduler failure");
      }
      return schedule(fn, ms, ...args);
    });
    let stopOther: (() => void) | undefined;
    try {
      failPosts = true;
      await s.resubscribe("view", "A");
      if (trigger === "continuation") {
        stopOther = s.streamSub("global", "", () => {});
        finish!();
      }
      await new Promise<void>((resolve) => schedule(resolve, trigger === "retry" ? 300 : 20));
      expect(thrown).toBe(true);
      expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/diag", expect.objectContaining({
        body: expect.stringContaining('"m":"subsync:controlled retry scheduler failure"'),
      }));

      // The failed finally block must not strand the pump in `syncing`.
      post.mockClear();
      failPosts = false;
      es.fail(false); es.open(); es.msg({ kind: "meta", type: "ready", epoch: "one" });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/diag", expect.objectContaining({
        body: expect.stringContaining(`"a":${trigger === "continuation" ? 2 : 1},"r":1,"s":200`),
      }));
    } finally {
      timer.mockRestore();
      stop(); stopOther?.();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
  },
);
