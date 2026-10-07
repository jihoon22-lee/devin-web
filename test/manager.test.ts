import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

const stateDir = mkdtempSync(join(tmpdir(), "dw-mgr-state-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

import { SessionManager } from "../lib/acp/manager";
import { METHODS } from "../lib/acp/types";
import { DEVIN_CLI_DIR, LockedSessionError } from "../lib/locks";
import { blocksToDraft } from "../lib/client/restore";
import { readAllQueues, writeSessionQueue } from "../lib/promptQueue";
import { QUEUE_MAX_BYTES } from "../lib/limits";

/** Stub the bridge + ensure() so no real `devin acp` process is spawned. */
function stubbed(): SessionManager {
  const m = new SessionManager();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (m as any).ensure = async () => ({});
  return m;
}

describe("SessionManager.loadSession rollback", () => {
  it("does not leave a failed load marked active", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async (method: string) => {
      if (method === METHODS.sessionLoad) throw new Error("session_locked");
      if (method === METHODS.sessionList)
        return { sessions: [{ sessionId: "s1", cwd: "/tmp/x" }] };
      return {};
    };

    await expect(m.loadSession("s1", "/tmp/x")).rejects.toThrow("session_locked");

    const list = await m.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].active).toBe(false);
    expect(list[0].running).toBe(false);
  });

  it("marks a successful load as active", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async (method: string) => {
      if (method === METHODS.sessionLoad) return { sessionId: "s2" };
      if (method === METHODS.sessionList)
        return { sessions: [{ sessionId: "s2", cwd: "/tmp/x" }] };
      return {};
    };

    await m.loadSession("s2", "/tmp/x");
    const list = await m.listSessions();
    expect(list[0].active).toBe(true);
  });

  it("re-attaches a loaded session after an acp restart (generation bump)", async () => {
    const m = stubbed();
    let loads = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async (method: string) => {
      if (method === METHODS.sessionLoad) {
        loads++;
        return { sessionId: "s3" };
      }
      if (method === METHODS.sessionList)
        return { sessions: [{ sessionId: "s3", cwd: "/tmp/x" }] };
      return {};
    };

    await m.loadSession("s3", "/tmp/x");
    expect(loads).toBe(1);

    // simulate acp death: onExit bumps generation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).generation++;

    // stale entry → session no longer reports active…
    let list = await m.listSessions();
    expect(list[0].active).toBe(false);

    // …and an explicit load re-issues session/load instead of early-returning
    await m.loadSession("s3", "/tmp/x");
    expect(loads).toBe(2);
    list = await m.listSessions();
    expect(list[0].active).toBe(true);
  });

  it("shares one in-flight session/load between concurrent openers", async () => {
    const m = stubbed();
    let loads = 0;
    let release: (() => void) | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async (method: string) => {
      if (method === METHODS.sessionLoad) {
        loads++;
        await new Promise<void>((r) => { release = r; });
        return { sessionId: "sx" };
      }
      if (method === METHODS.sessionList)
        return { sessions: [{ sessionId: "sx", cwd: "/tmp/x" }] };
      return {};
    };

    const p1 = m.loadSession("sx", "/tmp/x");
    const p2 = m.loadSession("sx", "/tmp/x");
    await new Promise((r) => setTimeout(r, 0));
    expect(loads).toBe(1);
    release!();
    expect(await p1).toMatchObject({ sessionId: "sx" });
    expect(await p2).toMatchObject({ sessionId: "sx" });

    // settled entries are removed — a stale load can be re-issued
    await m.loadSession("sx", "/tmp/x"); // already-loaded fast path
    expect(loads).toBe(1);
  });

  it("dismissNotice drops an overlay notice for every view and rejects unknown ids", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    mi.sessions.set("sx", {
      sessionId: "sx", cwd: "/tmp", running: false, loaded: true,
      attachedGen: mi.generation, queue: [],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async (method: string) => {
      if (method === METHODS.sessionPrompt) throw new Error("daily usage quota exhausted");
      return {};
    };
    const itemFrames: { kind: string; id?: string }[][] = [];
    m.subscribeView("sx", (ev) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (ev.t === "patch" && ev.meta?.items) itemFrames.push(ev.meta.items as any);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await m.prompt("sx", [{ type: "text", text: "go" }] as any);
    await new Promise((r) => setTimeout(r, 10));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = (m as any).view.meta("sx").items;
    const notice = items.find((i: { kind: string }) => i.kind === "notice");
    expect(notice.text).toContain("quota");

    expect(m.dismissNotice("sx", notice.id)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((m as any).view.meta("sx").items).toEqual([]);
    expect(itemFrames.at(-1)).toEqual([]); // the removal went out as a meta.items patch
    expect(m.dismissNotice("sx", notice.id)).toBe(false); // already gone
    expect(m.dismissNotice("sx", "ev-9999")).toBe(false);
  });
});

describe("reattach consistency (2-3, 2-4)", () => {
  /** Real ensure() over a stubbed bridge — reattachStale actually runs. */
  function realEnsure() {
    const m = new SessionManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).ensure = async () => ({});
    return m;
  }

  it("prompt waits for reattach to finish after an acp restart", async () => {
    const m = realEnsure();
    const order: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async (method: string) => {
      order.push(method);
      if (method === METHODS.sessionLoad) return { sessionId: "s4" };
      if (method === METHODS.sessionPrompt) return { stopReason: "end_turn" };
      return {};
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.set("s4", {
      sessionId: "s4", cwd: "/tmp/x", running: false,
      loaded: true, attachedGen: -1, queue: [],
    });

    await m.prompt("s4", [{ type: "text", text: "hi" } as never]);
    await new Promise((r) => setImmediate(r)); // runPrompt settles
    expect(order.slice(0, 2)).toEqual([METHODS.sessionLoad, METHODS.sessionPrompt]);
  });

  it("backs off a failed reattach instead of retrying every ensure", async () => {
    const m = realEnsure();
    let loads = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async (method: string) => {
      if (method === METHODS.sessionLoad) {
        loads++;
        throw new Error("session_locked");
      }
      return {};
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.set("s5", {
      sessionId: "s5", cwd: "/tmp/x", running: false,
      loaded: true, attachedGen: -1, queue: [],
    });

    // generation bump → first ensure reattaches and fails
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).generation = 2;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.get("s5").attachedGen = 1;

    await m.ensure();
    expect(loads).toBe(1);
    // failure is marked — immediate second ensure must not retry
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).ensure = async () => ({}); // bridge "restarts" again
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).generation = 3;
    await m.ensure();
    expect(loads).toBe(1); // still backed off
  });

  it("drains a parked queue after an acp restart reattach", async () => {
    const m = realEnsure();
    const prompts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async (method: string, params?: { prompt?: { text?: string }[] }) => {
      if (method === METHODS.sessionLoad) return { sessionId: "sq" };
      if (method === METHODS.sessionPrompt) {
        prompts.push(params?.prompt?.[0]?.text ?? "?");
        return { stopReason: "end_turn" };
      }
      return {};
    };

    // a queue parked while running, then the agent dies mid-wait:
    // generation bumps, running clears — the queue must not go dormant
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.set("sq", {
      sessionId: "sq", cwd: "/tmp/x", running: true,
      loaded: true, attachedGen: 0,
      queue: [
        { id: "q-1", blocks: [{ type: "text", text: "first" }] },
        { id: "q-2", blocks: [{ type: "text", text: "second" }] },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).generation = 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.get("sq").running = false;

    await m.ensure(); // reattachStale re-loads, then drains the parked queue
    await new Promise((r) => setTimeout(r, 10));
    expect(prompts).toEqual(["first", "second"]);
  });

  it("prompt on a detached session rejects with the attach error", async () => {
    const m = realEnsure();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async (method: string) => {
      if (method === METHODS.sessionLoad) throw new Error("session_locked");
      return {};
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.set("sd", {
      sessionId: "sd", cwd: "/tmp/x", running: false,
      loaded: true, attachedGen: 0, queue: [],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).generation = 1;

    // reattach fails (locked) → prompt must surface THAT error, not an
    // opaque turn_error from a generation that never loaded the session
    await expect(
      m.prompt("sd", [{ type: "text", text: "x" } as never]),
    ).rejects.toThrow("session_locked");
  });
});

describe("cancel / exit pending-request cleanup (2-5, 2-6)", () => {
  const fakePending = (m: SessionManager, sessionId: string) => {
    const done: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = mi.pendingRequests as Map<string, any>;
    const settle = () => {
      map.delete("req-1");
      mi.emit(sessionId, "client_request_done", { requestId: "req-1" });
    };
    map.set("req-1", {
      requestId: "req-1", sessionId, method: METHODS.requestPermission,
      params: {}, createdAt: Date.now(),
      respond: settle,
      respondError: settle,
    });
    m.subscribeView(sessionId, (e) => {
      if (e.t === "patch" && e.meta?.items) {
        for (const item of e.meta.items) if (item.kind === "request" && item.resolved) done.push(item.requestId);
      }
    });
    return { done, map };
  };

  it("cancel() answers pending client requests for the session", () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).notify = () => {};
    const { done, map } = fakePending(m, "s6");
    m.cancel("s6");
    expect(map.size).toBe(0);
    expect(done).toEqual(["req-1"]);
  });

  it("respond/cancel refuse a request owned by another session", () => {
    const m = stubbed();
    const { done, map } = fakePending(m, "s-owner");
    // the respond route passes the URL's session id — a requestId belonging
    // to a different session must not be answerable through it
    expect(m.respondToRequest("req-1", {}, "s-other")).toBe(false);
    expect(map.has("req-1")).toBe(true);
    expect(m.cancelRequest("req-1", "s-other")).toBe(false);
    expect(map.has("req-1")).toBe(true);
    expect(m.respondToRequest("req-1", {}, "s-owner")).toBe(true);
    expect(done).toEqual(["req-1"]);
    expect(map.has("req-1")).toBe(false);
  });

  it("request ids carry a random suffix (not enumerable)", () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).onClientRequest({
      method: METHODS.requestPermission,
      params: { sessionId: "sx" },
      respond: () => {},
      respondError: () => {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = [...((m as any).pendingRequests as Map<string, unknown>).keys()];
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^req-\d+-[0-9a-f]{12}$/);
  });

  it("cancel({clearQueue}) drops queued prompts", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).notify = () => {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.set("s7", {
      sessionId: "s7", cwd: "/tmp/x", running: true,
      loaded: true, attachedGen: 0, queue: [{ id: "q-1", blocks: [{ type: "text", text: "q" }] }],
    });
    m.cancel("s7", { clearQueue: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((m as any).sessions.get("s7").queue).toHaveLength(0);
  });

  it("dequeue removes one queued prompt by id and returns its blocks", async () => {
    const m = stubbed();
    type QV = { id: string; text: string };
    const states: { queued: number; queue?: QV[] }[] = [];
    m.subscribeView("s9", (e) => {
      if (e.t === "patch" && e.meta?.queueItems) states.push({ queued: e.meta.queued!, queue: e.meta.queueItems });
    });
    const second = [
      { type: "text", text: "second" },
      { type: "resource_link", name: "f.ts", uri: "file:///f.ts" },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.set("s9", {
      sessionId: "s9", cwd: "/tmp/x", running: true,
      loaded: true, attachedGen: 0,
      queue: [
        { id: "q-a", blocks: [{ type: "text", text: "first\nmultiline" }] },
        { id: "q-b", blocks: second },
      ],
    });
    // prompt while running appends + emits queue previews
    await m.prompt("s9", [{ type: "text", text: "third" } as never]);
    const last = states[states.length - 1];
    expect(last.queued).toBe(3);
    expect(last.queue!.map((q) => q.text)).toEqual(["first", "second @f.ts", "third"]);
    const thirdId = last.queue![2].id;
    expect(thirdId).toMatch(/^q-[a-z0-9]+-\d+$/); // runId-scoped

    expect(m.dequeue("s9", "q-b")).toEqual({ blocks: second });
    expect(states[states.length - 1].queue!.map((q) => q.id)).toEqual(["q-a", thirdId]);
    expect(m.dequeue("s9", "missing")).toBeNull();
  });

  it("queue previews carry mention chips and attachment counts", async () => {
    // a ghost bubble rendered from queueItems must show what was attached —
    // text-only previews hid images and file mentions until drain
    const m = stubbed();
    type QV = { id: string; text: string; mentions?: { path: string; name: string }[]; attachments?: number };
    const states: { queue?: QV[] }[] = [];
    m.subscribeView("s13", (e) => {
      if (e.t === "patch" && e.meta?.queueItems) states.push({ queue: e.meta.queueItems });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.set("s13", {
      sessionId: "s13", cwd: "/tmp/x", running: true,
      loaded: true, attachedGen: 0, queue: [],
    });
    await m.prompt("s13", [
      { type: "text", text: "check this" },
      { type: "resource_link", name: "app.ts", uri: "file:///x/app%20%231.ts" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ] as never);
    const q = states[states.length - 1].queue![0];
    expect(q.text).toContain("check this");
    expect(q.mentions).toEqual([{ path: "/x/app #1.ts", name: "app.ts" }]);
    expect(q.attachments).toBe(1);
  });

  it("tags every synthetic echo and re-uses the queue id at drain", async () => {
    // every user_message echo carries echoId so the client renders it
    // unconditionally (seed coverage must never eat a just-sent prompt).
    // A queued prompt emits nothing at send time — it surfaces as a ghost
    // bubble derived from queueItems — and its drain echo re-uses the queue
    // entry's id so reconnect replays dedup.
    const m = stubbed();
    // Inspect the producer contract: echoId still selects encoded display mentions.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitted = vi.spyOn(m as any, "emit");
    const echoes = () => emitted.mock.calls.filter(([, type, data]) => type === "session_update" && (data as { sessionUpdate?: string }).sessionUpdate === "user_message").map(([, , data]) => (data as { echoId?: string }).echoId);
    let release: () => void = () => {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = (method: string) =>
      method === METHODS.sessionPrompt
        ? new Promise((r) => {
            release = () => r({ stopReason: "end_turn" });
          })
        : Promise.resolve({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.set("s12", {
      sessionId: "s12", cwd: "/tmp/x", running: false,
      loaded: true, attachedGen: 0, queue: [],
    });
    await m.prompt("s12", [{ type: "text", text: "A" } as never]); // direct → d-*
    await m.prompt("s12", [{ type: "text", text: "B" } as never]); // queued → silent
    const queuedId = m.view.meta("s12").queueItems![0].id;
    expect(echoes()).toHaveLength(1);
    release(); // turn ends → queue drains → B's echo emitted now
    await new Promise((r) => setTimeout(r, 10));
    expect(echoes()).toEqual([expect.stringMatching(/^d-/), queuedId]);
    emitted.mockRestore();
  });

  it("runs queued prompts in order with their full blocks", async () => {
    const m = stubbed();
    const sent: unknown[] = [];
    let release: () => void = () => {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = (method: string, params: { prompt?: unknown }) => {
      if (method !== METHODS.sessionPrompt) return Promise.resolve({});
      sent.push(params.prompt);
      return new Promise((r) => {
        release = () => r({ stopReason: "end_turn" });
      });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.set("s10", {
      sessionId: "s10", cwd: "/tmp/x", running: false,
      loaded: true, attachedGen: 0, queue: [],
    });
    const a = [{ type: "text", text: "first" }];
    const b = [
      { type: "text", text: "second\nline" },
      { type: "image", data: "AA", mimeType: "image/png" },
    ];
    await m.prompt("s10", a as never);
    await m.prompt("s10", b as never);
    expect(sent).toEqual([a]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([a, b]);
  });

  it("sendQueuedNow steers a parked prompt into the live turn", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitted = vi.spyOn(m as any, "emit");
    const prompts: string[] = [];
    const releases: (() => void)[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = (method: string, params: { prompt?: { text: string }[] }) => {
      if (method !== METHODS.sessionPrompt) return Promise.resolve({});
      prompts.push(params.prompt![0].text);
      return new Promise((r) => releases.push(() => r({ stopReason: "end_turn" })));
    };
    const s = { sessionId: "s20", cwd: "/tmp/x", running: false, loaded: true, attachedGen: 0, queue: [] as { id: string; blocks: unknown[] }[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.set("s20", s);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).generation = 0;

    await m.prompt("s20", [{ type: "text", text: "first" } as never]); // turn 1 starts
    await m.prompt("s20", [{ type: "text", text: "steer me" } as never]); // parked
    await m.prompt("s20", [{ type: "text", text: "still queued" } as never]);
    const qid = s.queue[0]!.id;
    const stillId = s.queue[1]!.id;
    expect(prompts).toEqual(["first"]);

    expect(m.sendQueuedNow("s20", qid)).toEqual({ sent: true });
    // queue shrank, the echo rendered immediately, and a second in-flight
    // session/prompt went out without waiting for turn 1 to end
    expect(s.queue.map((q) => q.id)).toHaveLength(1);
    // the removal is mirrored to disk synchronously — a restart must not
    // replay an already-sent prompt
    expect(readAllQueues()["s20"]?.map((q) => q.id)).toEqual([stillId]);
    expect(prompts).toEqual(["first", "steer me"]);
    const echo = emitted.mock.calls.find(
      ([, type, data]) =>
        type === "session_update" &&
        (data as { echoId?: string }).echoId === qid,
    );
    expect(echo).toBeTruthy();

    // turn 1 ends while the steer is still out — running must hold, and the
    // daemon's synthesized turn_end for prompt 1 must not clear it
    releases[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.running).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).onNotification("_devin-web/turn_end", { sessionId: "s20" });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.running).toBe(true);
    expect(s.queue).toHaveLength(1); // nothing drained mid-steer

    // the steered turn resolves → running drops and the parked prompt drains
    releases[1]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.running).toBe(true); // turn 3 (drained queue) is now running
    expect(prompts).toEqual(["first", "steer me", "still queued"]);
    expect(s.queue).toHaveLength(0);
    expect(readAllQueues()["s20"] ?? []).toEqual([]);
    emitted.mockRestore();
  });

  it("sendQueuedNow failure returns the prompt to the queue with a notice", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitted = vi.spyOn(m as any, "emit");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = (method: string) =>
      method === METHODS.sessionPrompt
        ? Promise.reject(new Error("agent gone"))
        : Promise.resolve({});
    const s = { sessionId: "s21", cwd: "/tmp/x", running: true, loaded: true, attachedGen: 0, queue: [
      { id: "q-a", blocks: [{ type: "text", text: "first" }] },
      { id: "q-b", blocks: [{ type: "text", text: "steer" }] },
    ] as { id: string; blocks: unknown[] }[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.set("s21", s);

    expect(m.sendQueuedNow("s21", "q-b")).toEqual({ sent: true });
    // removal is on disk before the send attempt settles
    expect(readAllQueues()["s21"]?.map((q) => q.id)).toEqual(["q-a"]);
    await new Promise((r) => setTimeout(r, 10));
    // content is back at its old queue position, durable again
    expect(s.queue.map((q) => q.id)).toEqual(["q-a", "q-b"]);
    expect(readAllQueues()["s21"]?.map((q) => q.id)).toEqual(["q-a", "q-b"]);
    const notice = emitted.mock.calls.find(([, type]) => type === "notice");
    expect(notice).toBeTruthy();
    emitted.mockRestore();
  });

  it("sendQueuedNow on an idle session just drains the entry", async () => {
    const m = stubbed();
    const prompts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = (method: string, params: { prompt?: { text: string }[] }) => {
      if (method === METHODS.sessionPrompt) prompts.push(params.prompt![0].text);
      return Promise.resolve({ stopReason: "end_turn" });
    };
    const s = { sessionId: "s22", cwd: "/tmp/x", running: false, loaded: true, attachedGen: 0, queue: [
      { id: "q-p", blocks: [{ type: "text", text: "parked" }] },
    ] as { id: string; blocks: unknown[] }[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.set("s22", s);
    expect(m.sendQueuedNow("s22", "q-p")).toEqual({ sent: true });
    // idle send-now also mirrors the removal — restart must not replay it
    expect(readAllQueues()["s22"] ?? []).toEqual([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(prompts).toEqual(["parked"]);
    expect(m.sendQueuedNow("s22", "missing")).toBeNull();
  });

  it("rename and share go straight to the instant slash commands", async () => {
    const m = stubbed();
    const sent: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = (method: string, params: { prompt?: unknown }) => {
      sent.push([method, params.prompt]);
      return new Promise(() => {}); // the turn never ends in this test
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.set("s11", {
      sessionId: "s11", cwd: "/tmp/x", running: false,
      loaded: true, attachedGen: 0, queue: [],
    });
    await m.renameSession("s11", "New name");
    await m.shareSession("s11"); // queued behind the rename turn
    expect(sent).toEqual([[METHODS.sessionPrompt, [{ type: "text", text: "/rename New name" }]]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((m as any).sessions.get("s11").queue[0].blocks).toEqual([{ type: "text", text: "/share" }]);
  });

  it("acp exit resolves every pending request with an error + done event", () => {
    const m = stubbed();
    const { done, map } = fakePending(m, "s8");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers = (m.bridge as any).handlers as {
      onExit: (code: number | null, signal: string | null) => void;
    };
    handlers.onExit(1, null); // simulate the acp process dying
    expect(map.size).toBe(0);
    expect(done).toEqual(["req-1"]);
  });
});

describe("shim notifications (D6)", () => {
  it("_devin-web/terminal_created reaches view metadata AND global subs", () => {
    const m = stubbed();
    const sessionEvents: string[] = [];
    const globalEvents: string[] = [];
    m.subscribeView("s12", (e) => { if (e.t === "patch" && e.meta?.terminalIds) sessionEvents.push(...e.meta.terminalIds); });
    m.subscribeGlobal((e) => globalEvents.push(e.type));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers = (m.bridge as any).handlers as {
      onNotification: (method: string, params: unknown) => void;
    };
    handlers.onNotification("_devin-web/terminal_created", {
      sessionId: "s12",
      terminalId: "t-1",
    });
    // session stream gets it — the reducer's terminalIds tracking is live again
    expect(sessionEvents).toEqual(["t-1"]);
    // global broadcast kept for shim-signal logging
    expect(globalEvents).toEqual(["notification"]);
  });

  it("_devin-web signals without a sessionId stay global-only", () => {
    const m = stubbed();
    const sessionEvents: string[] = [];
    m.subscribeView("s12", (e) => { if (e.t === "patch" && e.meta?.terminalIds) sessionEvents.push(...e.meta.terminalIds); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers = (m.bridge as any).handlers as {
      onNotification: (method: string, params: unknown) => void;
    };
    handlers.onNotification("_devin-web/resync_needed", {});
    expect(sessionEvents).toEqual([]);
  });
});

describe("queued prompts vs daemon-synthesized turn_end (N1)", () => {
  it("does not start two queued prompts at once", async () => {
    const m = stubbed();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let inFlight = 0, maxInFlight = 0;
    const order: string[] = [];
    const resolvers: (() => void)[] = [];
    (m.bridge as any).request = (method: string, params: any) => {
      if (method !== METHODS.sessionPrompt) return Promise.resolve({});
      order.push(params.prompt[0].text);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((res) => resolvers.push(() => { inFlight--; res({}); }));
    };
    (m as any).sessions.set("s1", {
      sessionId: "s1", cwd: "/tmp", running: false, loaded: true,
      attachedGen: (m as any).generation, queue: [],
    });

    await m.prompt("s1", [{ type: "text", text: "A" }]);
    await m.prompt("s1", [{ type: "text", text: "B" }]);
    await m.prompt("s1", [{ type: "text", text: "C" }]);
    expect(order).toEqual(["A"]);

    // the daemon writes the prompt response and its synthesized turn_end in
    // the same tick — the bridge dispatches both synchronously, so turn_end
    // lands BEFORE the awaiting runPrompt resumes
    resolvers[0]();
    (m as any).onNotification("_devin-web/turn_end", { sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 10));

    expect(maxInFlight).toBe(1);          // was 2: B and C overlapped
    expect(order).toEqual(["A", "B"]);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
});

describe("rename / delete / queue hardening (D5, D7, D8)", () => {
  const loaded = (m: SessionManager, id: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    mi.sessions.set(id, {
      sessionId: id, cwd: "/tmp", running: false, loaded: true,
      attachedGen: mi.generation, queue: [],
    });
  };

  it("strips newlines from rename titles (prompt-injection surface)", async () => {
    const m = stubbed();
    loaded(m, "s1");
    let sent = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async (method: string, p: any) => {
      if (method === METHODS.sessionPrompt) sent = p.prompt[0].text;
      return {};
    };
    await m.renameSession("s1", "good name\n/injected\r\nmore");
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toBe("/rename good name /injected more");
    await expect(m.renameSession("s1", "\n\n")).rejects.toThrow("empty title");
  });

  it("deleteSession rejects the session's pending permission requests", async () => {
    const m = stubbed();
    loaded(m, "s1");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async () => ({});
    let rejected = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).pendingRequests.set("req-1", {
      requestId: "req-1", sessionId: "s1", method: "session/request_permission",
      params: {}, createdAt: 0,
      respond: () => {},
      respondError: (_c: number, msg: string) => {
        rejected = msg;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (m as any).pendingRequests.delete("req-1");
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).pendingRequests.set("req-2", {
      requestId: "req-2", sessionId: "other", method: "session/request_permission",
      params: {}, createdAt: 0,
      respond: () => {},
      respondError: () => { throw new Error("must not fire"); },
    });
    await m.deleteSession("s1");
    expect(rejected).toBe("session deleted");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((m as any).pendingRequests.has("req-1")).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((m as any).pendingRequests.has("req-2")).toBe(true);
  });

  it("rejects prompts once the queue hits the cap", async () => {
    const m = stubbed();
    loaded(m, "s1");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = () => new Promise(() => {}); // turn never ends
    await m.prompt("s1", [{ type: "text", text: "first" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (m as any).sessions.get("s1");
    s.running = true;
    for (let i = 0; i < 50; i++) await m.prompt("s1", [{ type: "text", text: `q${i}` }]);
    await expect(m.prompt("s1", [{ type: "text", text: "over" }])).rejects.toThrow("queue is full");
  });

  it("rejects queueing once the session's queued bytes pass QUEUE_MAX_BYTES", async () => {
    const m = stubbed();
    loaded(m, "s-bytes");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = () => new Promise(() => {}); // turn never ends
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (m as any).sessions.get("s-bytes");
    s.running = true;
    // a parked entry already over the byte cap refuses even a text prompt —
    // inline base64 payloads, not entry count, are what pin memory
    s.queue.push({
      id: "q-big",
      blocks: [{ type: "image", data: "x".repeat(QUEUE_MAX_BYTES), mimeType: "image/png" }],
    });
    await expect(m.prompt("s-bytes", [{ type: "text", text: "hi" }])).rejects.toThrow("queue is full");
    expect(s.queue).toHaveLength(1);
  });
});

describe("queued prompts across an agent exit mid-turn (H2)", () => {
  it("keeps the queue for the reattach drain instead of burning it", async () => {
    const m = new SessionManager();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (m.bridge as any).ensure = async () => ({}); // real manager.ensure → reattachStale runs
    let dead = false;
    const sent: string[] = [];
    let rejectFirst: ((e: Error) => void) | null = null;
    (m.bridge as any).request = (method: string, params: any) => {
      if (method === METHODS.sessionLoad) return Promise.resolve({ sessionId: "s1" });
      if (method !== METHODS.sessionPrompt) return Promise.resolve({});
      if (dead) return Promise.reject(new Error("devin acp is not running"));
      sent.push(params.prompt[0].text);
      if (sent.length === 1) return new Promise((_res, rej) => { rejectFirst = rej; });
      return Promise.resolve({ stopReason: "end_turn" });
    };
    const errors: string[] = [];
    m.subscribeView("s1", (ev) => {
      if (ev.t === "patch" && ev.meta?.items) {
        for (const item of ev.meta.items) if (item.kind === "notice") errors.push(item.text);
      }
    });
    (m as any).sessions.set("s1", {
      sessionId: "s1", cwd: "/tmp", running: false, loaded: true,
      attachedGen: (m as any).generation, queue: [],
    });
    await m.prompt("s1", [{ type: "text", text: "A" }]);
    await m.prompt("s1", [{ type: "text", text: "B" }]);
    await m.prompt("s1", [{ type: "text", text: "C" }]);

    // AcpBridge onGone order: reject this generation's pending → proc=null → onExit
    dead = true;
    rejectFirst!(new Error("devin acp exited"));
    (m.bridge as any).handlers.onExit(null, "SIGKILL");
    await new Promise((r) => setTimeout(r, 10));

    expect(errors).toEqual(["Error: devin acp exited"]); // only the in-flight turn fails
    expect((m as any).sessions.get("s1").queue.map((q: any) => q.blocks[0].text)).toEqual(["B", "C"]);

    // the agent is back: reattach re-loads the session, then drains in order
    dead = false;
    await m.ensure();
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual(["A", "B", "C"]);
  });
});

describe("queue persistence across web restarts", () => {
  const blk = (t: string) => [{ type: "text", text: t }] as never[];
  /* eslint-disable @typescript-eslint/no-explicit-any */

  it("a prompt queued before the restart drains after it instead of vanishing", async () => {
    // boot 1: session mid-turn, prompt parks — written to disk
    const m1 = stubbed();
    (m1 as any).sessions.set("sq1", {
      sessionId: "sq1", cwd: "/tmp", running: true, loaded: true,
      attachedGen: (m1 as any).generation, queue: [],
    });
    expect((await m1.prompt("sq1", blk("parked"))).queued).toBe(true);

    // boot 2 (web restart): fresh manager; the daemon still reports the
    // session busy, so the record is adopted — the parked prompt must
    // hydrate with it and drain when the turn ends
    const m2 = stubbed();
    const sent: string[] = [];
    (m2.bridge as any).request = (method: string, params: any) => {
      if (method === METHODS.sessionPrompt) {
        sent.push(params.prompt[0].text);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    };
    (m2 as any).sessions.set("sq1", {
      sessionId: "sq1", cwd: "/tmp", running: true, loaded: true,
      attachedGen: (m2 as any).generation,
      queue: (m2 as any).hydrateQueue("sq1"), adopted: true,
    });
    (m2 as any).onNotification("_devin-web/turn_end", { sessionId: "sq1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual(["parked"]);
    // drained → disk cleared too
    expect(m2.queueState("sq1").queued).toBe(0);
  });

  it("queueState exposes a persisted queue for a not-yet-attached session", () => {
    writeSessionQueue("sq-late", [{ id: "q-old-3", blocks: blk("waiting") }]);
    const m = stubbed(); // no session record — the file is the truth
    const st = m.queueState("sq-late");
    expect(st.queued).toBe(1);
    expect(st.queue[0]).toMatchObject({ id: "q-old-3", text: "waiting" });
    // and the stored id still dequeues once hydrated onto a record
    (m as any).sessions.set("sq-late", {
      sessionId: "sq-late", cwd: "/tmp", running: true, loaded: true,
      attachedGen: (m as any).generation, queue: (m as any).hydrateQueue("sq-late"),
    });
    expect(m.dequeue("sq-late", "q-old-3")).toEqual({ blocks: blk("waiting") });
    expect(readAllQueues()["sq-late"]).toBeUndefined();
  });

  it("queue/echo ids are boot-scoped so persisted queues can't collide", async () => {
    const m1 = stubbed();
    (m1 as any).sessions.set("sqid", {
      sessionId: "sqid", cwd: "/tmp", running: true, loaded: true,
      attachedGen: (m1 as any).generation, queue: [],
    });
    await m1.prompt("sqid", blk("old-boot"));
    const oldId = m1.queueState("sqid").queue[0].id;

    const m2 = stubbed(); // fresh boot → fresh runId → no id reuse
    (m2 as any).sessions.set("sqid", {
      sessionId: "sqid", cwd: "/tmp", running: true, loaded: true,
      attachedGen: (m2 as any).generation, queue: [],
    });
    await m2.prompt("sqid", blk("new-boot"));
    const newId = m2.queueState("sqid").queue[0].id;
    expect(newId).not.toBe(oldId);
    expect(newId).toMatch(/^q-[a-z0-9]+-\d+$/);
    m2.dequeue("sqid", newId);
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

describe("subscription bookkeeping", () => {
  it("unsubscribing the last listener drops the session's set — and a stale unsubscribe can't kill a live one", () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    const un1 = m.subscribeView("sx", () => {});
    const un2 = m.subscribeView("sx", () => {});
    un1();
    expect(mi.viewSubs.get("sx")!.size).toBe(1);
    un2();
    expect(mi.viewSubs.has("sx")).toBe(false);
    // double-invoking the dead unsubscribe must not drop the NEW set
    const un3 = m.subscribeView("sx", () => {});
    un2();
    expect(mi.viewSubs.get("sx")!.size).toBe(1);
    un3();
    expect(mi.viewSubs.has("sx")).toBe(false);
  });
});

describe("provisional region (two-region transcript)", () => {
  const openSession = async (m: SessionManager, sid = "s1") => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    mi.bridge.request = async (method: string) => {
      if (method === METHODS.sessionPrompt) return new Promise(() => {}); // turn stays open
      return {};
    };
    mi.sessions.set(sid, {
      sessionId: sid, cwd: "/tmp/x", running: false, loaded: true,
      attachedGen: mi.generation, queue: [],
    });
  };

  it("assembles the running turn and drops it once durable rows cover it", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    await openSession(m);
    await m.prompt("s1", [{ type: "text", text: "hi" }]);
    mi.emit("s1", "session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
    expect(m.provisional("s1").map((i) => i.text)).toEqual(["hi", "partial"]);
    mi.emit("s1", "turn_end", {});
    expect(m.provisional("s1").every((i) => i.done)).toBe(true);
    m.__testDurableThrough("s1", 999); // db watcher advanced past the turn
    expect(m.provisional("s1")).toEqual([]);
  });

  it("retains thoughts/plans anchored inside the turn after the durable flip", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    await openSession(m);
    m.__testDurableThrough("s1", 100);
    await m.prompt("s1", [{ type: "text", text: "go" }]);
    mi.emit("s1", "session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking…" } });
    mi.emit("s1", "session_update", { sessionUpdate: "plan", entries: [{ content: "step", status: "pending" }] });
    mi.emit("s1", "session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
    mi.emit("s1", "turn_end", {});
    // durable covers the turn — no sessions.db rows exist in the test env,
    // so the spine read yields [] and retained items anchor at turn start
    m.__testDurableThrough("s1", 160);
    expect(m.provisional("s1")).toEqual([]);
    const ret = m.retained("s1");
    expect(ret.map((i) => i.role ?? i.kind)).toEqual(["thought", "plan"]);
    expect(ret.every((i) => i.anchorNode === 100)).toBe(true);
  });

  it("keeps the prior turn's retained items untouched while a new turn runs", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    await openSession(m);
    m.__testDurableThrough("s1", 100);
    await m.prompt("s1", [{ type: "text", text: "first" }]);
    mi.emit("s1", "session_update", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "old thought" },
    });
    mi.emit("s1", "turn_end", {});
    m.__testDurableThrough("s1", 160); // turn 1 flips → retained
    const before = m.retained("s1");
    expect(before).toHaveLength(1);
    // turn 2 opens a fresh provisional region at the new watermark
    await m.prompt("s1", [{ type: "text", text: "second" }]);
    mi.emit("s1", "session_update", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "new thought" },
    });
    expect(m.provisional("s1").some((i) => i.text === "new thought")).toBe(true);
    // the live region must not bleed into the retained layer
    expect(m.retained("s1")).toEqual(before);
    mi.emit("s1", "turn_end", {});
    m.__testDurableThrough("s1", 220); // turn 2 flips → appends, not replaces
    const ret = m.retained("s1");
    expect(ret.map((i) => i.text)).toEqual(["old thought", "new thought"]);
    expect(ret[0].anchorNode).toBe(100);
    expect(ret[1].anchorNode).toBe(160);
  });

  it("a turn with nothing retainable still drops cleanly", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    await openSession(m);
    m.__testDurableThrough("s1", 100);
    await m.prompt("s1", [{ type: "text", text: "go" }]);
    mi.emit("s1", "session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
    mi.emit("s1", "turn_end", {});
    m.__testDurableThrough("s1", 160);
    expect(m.provisional("s1")).toEqual([]);
    expect(m.retained("s1")).toEqual([]);
  });

  it("freezes the durable watermark at turn start so mid-turn commits stay out", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    await openSession(m);
    m.__testDurableThrough("s1", 100); // pre-turn durable state
    await m.prompt("s1", [{ type: "text", text: "go" }]);
    expect(m.turnStartNode("s1")).toBe(100);
    m.__testDurableThrough("s1", 140); // CLI commits mid-turn — durable must not advance
    expect(m.durableThrough("s1")).toBe(100);
    mi.emit("s1", "turn_end", {});
    m.__testDurableThrough("s1", 160); // post-turn commit covers the turn
    expect(m.durableThrough("s1")).toBe(160);
    expect(m.provisional("s1")).toEqual([]);
  });

  it("freezes the durable watermark at adoption, before any content update", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    // daemon-socket mode: shim_state reports the session busy → loadSession
    // adopts it in place instead of re-issuing session/load
    mi.bridge.proc = { pid: -1 };
    mi.bridge.request = async (method: string) =>
      method === "_devin-web/shim_state"
        ? { gen: 1, sessions: [{ sessionId: "s8", cwd: "/tmp/x", loadResult: null, busy: true }] }
        : {};
    m.__testDurableThrough("s8", 100); // durable tip at adoption
    await m.loadSession("s8", "/tmp/x");
    expect(m.getSession("s8")?.adopted).toBe(true);
    // the running turn's commits keep landing while no content update has
    // arrived yet — the watermark must hold at the adoption freeze, not
    // track the advancing db tip (the sunkLive leak)
    m.__testDurableThrough("s8", 140);
    expect(m.durableThrough("s8")).toBe(100);
  });

  it("lazily assembles an adopted running session's stream", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    mi.sessions.set("s9", {
      sessionId: "s9", cwd: "/tmp/x", running: true, loaded: true,
      attachedGen: mi.generation, queue: [], adopted: true,
    });
    mi.emit("s9", "session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "resumed" } });
    expect(m.provisional("s9").map((i) => i.text)).toEqual(["resumed"]);
    // an adopted turn can't know its true start — freeze at adoption so
    // durable keeps everything committed so far (no overlap with provisional)
    expect(m.turnStartNode("s9")).not.toBeNull();
  });

  it("closes thought items on thinking_complete and ends on agent_stopped", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    await openSession(m, "s2");
    await m.prompt("s2", [{ type: "text", text: "go" }]);
    mi.emit("s2", "session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } });
    expect(m.provisional("s2").at(-1)?.done).toBe(false);
    mi.emit("s2", "notification", { method: "_cognition.ai/thinking_complete" });
    expect(m.provisional("s2").at(-1)?.done).toBe(true);
    mi.emit("s2", "notification", { method: "_cognition.ai/agent_stopped", params: { sessionId: "s2" } });
    expect(m.provisional("s2").every((i) => i.done)).toBe(true);
  });

  it("an empty ended turn drops immediately instead of pinning the watermark", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    mi.sessions.set("s3", {
      sessionId: "s3", cwd: "/tmp/x", running: true, loaded: true,
      attachedGen: mi.generation, queue: [], adopted: true,
    });
    // a no-item update creates the assembler lazily (running turn), then the
    // turn ends having assembled nothing — no durable coverage is coming for
    // it, so the freeze must release at once
    mi.emit("s3", "session_update", { sessionUpdate: "plan" }); // entries missing → no item
    expect(m.turnStartNode("s3")).not.toBeNull();
    mi.emit("s3", "turn_end", {});
    expect(m.provisional("s3")).toEqual([]);
    expect(m.turnStartNode("s3")).toBeNull(); // watermark unfrozen
  });

  it("restores the provisional region after a web restart mid-turn", async () => {
    const m1 = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi1 = m1 as any;
    await openSession(m1, "s5");
    m1.__testDurableThrough("s5", 77);
    await m1.prompt("s5", [{ type: "text", text: "hi" }]);
    mi1.emit("s5", "session_update", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "pondering" },
    });
    // let the flush timer persist the region to itemlog.db
    await new Promise((r) => setTimeout(r, 80));

    // simulate a web restart: fresh manager + fresh log handle, the daemon's
    // session is still running
    const { itemLogResetForTests } = await import("../lib/itemLog");
    itemLogResetForTests();
    const m2 = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi2 = m2 as any;
    mi2.sessions.set("s5", {
      sessionId: "s5", cwd: "/tmp/x", running: true, loaded: true,
      attachedGen: mi2.generation, queue: [], adopted: true,
    });
    m2.__testDurableThrough("s5", 77); // same durable state as before restart
    const restored = m2.provisional("s5");
    expect(restored.map((i) => i.text)).toEqual(["hi", "pondering"]);
    expect(m2.turnStartNode("s5")).toBe(77); // watermark restored with it
    // continued assembly must not collide with restored item ids
    mi2.emit("s5", "session_update", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: " more" },
    });
    expect(m2.provisional("s5").at(-1)).toMatchObject({ text: "pondering more" });
  });

  it("drops a restored turn once durable rows cover its end", async () => {
    const m1 = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi1 = m1 as any;
    await openSession(m1, "s6");
    m1.__testDurableThrough("s6", 50);
    await m1.prompt("s6", [{ type: "text", text: "hi" }]);
    mi1.emit("s6", "session_update", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "done answer" },
    });
    mi1.emit("s6", "turn_end", {});
    await new Promise((r) => setTimeout(r, 80)); // flush persists ended turn

    const { itemLogResetForTests } = await import("../lib/itemLog");
    itemLogResetForTests();
    const m2 = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi2 = m2 as any;
    mi2.sessions.set("s6", {
      sessionId: "s6", cwd: "/tmp/x", running: false, loaded: true,
      attachedGen: mi2.generation, queue: [], adopted: true,
    });
    // durable rows now cover the turn — restore must not resurrect it
    m2.__testDurableThrough("s6", 60);
    expect(m2.provisional("s6")).toEqual([]);
    expect(m2.durableThrough("s6")).toBe(60);
  });
});

describe("session/load replay vs the provisional region", () => {
  it("closes a stale restored region and keeps the load replay out of it", async () => {
    const m1 = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi1 = m1 as any;
    mi1.bridge.request = async (method: string) =>
      method === METHODS.sessionPrompt ? new Promise(() => {}) : {};
    mi1.sessions.set("r1", { sessionId: "r1", cwd: "/tmp/x", running: false, loaded: true, attachedGen: mi1.generation, queue: [] });
    m1.__testDurableThrough("r1", 40);
    await m1.prompt("r1", [{ type: "text", text: "go" }]);
    mi1.emit("r1", "session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "live thought" } });
    await new Promise((r) => setTimeout(r, 80)); // persisted with ended=false

    // web restarts; the turn ended while it was down (turn_end lost)
    const { itemLogResetForTests } = await import("../lib/itemLog");
    itemLogResetForTests();
    const m2 = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi2 = m2 as any;
    m2.__testDurableThrough("r1", 40);
    const states: unknown[] = [];
    mi2.bridge.request = async (method: string) => {
      if (method !== METHODS.sessionLoad) return {};
      // the agent replays the whole history before answering
      mi2.onSessionUpdate({ sessionId: "r1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "an old thought" } } });
      mi2.onSessionUpdate({ sessionId: "r1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old answer" } } });
      states.push(m2.provisional("r1").map((i) => i.text));
      return {};
    };
    await m2.loadSession("r1", "/tmp/x");
    expect(states).toEqual([["go", "live thought"]]); // replay never entered
    expect(mi2.regions.turnOpen("r1")).toBe(false); // the stale region was closed
    // after the load, a real turn's content assembles normally again
    mi2.sessions.get("r1").running = true;
    mi2.emit("r1", "session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new" } });
    expect(m2.provisional("r1").map((i) => i.text)).toContain("new");
  });

  it("an agent exit ends an adopted turn for its viewers and closes its region", async () => {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    mi.sessions.set("r2", { sessionId: "r2", cwd: "/tmp/x", running: true, loaded: true, attachedGen: mi.generation, queue: [], adopted: true });
    mi.emit("r2", "session_update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "adopted" } });
    expect(mi.regions.turnOpen("r2")).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).handlers.onExit(1, null);
    expect(mi.regions.turnOpen("r2")).toBe(false);
    expect(m.view.meta("r2").running).toBe(false);
  });
});

describe("deleteSession mid-turn", () => {
  function harness() {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    let release: () => void = () => {};
    const prompted: string[] = [];
    mi.bridge.request = async (method: string, params: { prompt?: { text?: string }[] }) => {
      if (method === METHODS.sessionNew) return { sessionId: "s-del" };
      if (method === METHODS.sessionPrompt) {
        prompted.push(params.prompt?.[0]?.text ?? "");
        if (prompted.length === 1) await new Promise<void>((r) => (release = r));
        return {};
      }
      return {};
    };
    mi.bridge.notify = () => {};
    return { m, mi, prompted, release: () => release() };
  }
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it("never sends a deleted session's queued prompts", async () => {
    const h = harness();
    await h.m.createSession("/tmp");
    await h.m.prompt("s-del", [{ type: "text", text: "one" }]);
    await h.m.prompt("s-del", [{ type: "text", text: "two" }]);
    await h.m.prompt("s-del", [{ type: "text", text: "three" }]);
    await h.m.deleteSession("s-del");
    h.release();
    await tick();
    expect(h.prompted).toEqual(["one"]);
    expect(readAllQueues()["s-del"] ?? []).toEqual([]);
  });

  it("drops the deleted session's regions and does not resurrect them at turn end", async () => {
    const h = harness();
    await h.m.createSession("/tmp");
    await h.m.prompt("s-del", [{ type: "text", text: "one" }]);
    await h.m.deleteSession("s-del");
    expect(h.mi.regions.prov.has("s-del")).toBe(false);
    expect(h.mi.regions.retainedBy.has("s-del")).toBe(false);
    h.release();
    await tick();
    expect(h.mi.regions.prov.has("s-del")).toBe(false);
    expect(h.m.view.version("s-del")).toBe(0);
  });

  it("a session re-created under the same id after delete runs prompts normally", async () => {
    const h = harness();
    await h.m.createSession("/tmp");
    await h.m.prompt("s-del", [{ type: "text", text: "one" }]);
    await h.m.deleteSession("s-del");
    h.release();
    await tick();
    await h.m.createSession("/tmp"); // the fake agent hands out the same id again
    await h.m.prompt("s-del", [{ type: "text", text: "fresh" }]);
    await tick();
    expect(h.prompted).toEqual(["one", "fresh"]);
  });
});

describe("queue drain while deletion RPC is pending", () => {
  function harness() {
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    let finishPrompt: (error?: Error) => void = () => {};
    let finishDelete: (error?: Error) => void = () => {};
    const prompted: string[] = [];
    mi.bridge.request = async (method: string, params: { prompt?: { text?: string }[] }) => {
      if (method === METHODS.sessionNew) return { sessionId: "s-delete-rpc" };
      if (method === METHODS.sessionDelete) {
        return new Promise((resolve, reject) => {
          finishDelete = (error) => error ? reject(error) : resolve({});
        });
      }
      if (method === METHODS.sessionPrompt) {
        prompted.push(params.prompt?.[0]?.text ?? "");
        if (prompted.length === 1) {
          return new Promise((resolve, reject) => {
            finishPrompt = (error) => error ? reject(error) : resolve({});
          });
        }
      }
      return {};
    };
    mi.bridge.notify = () => {};
    return { m, mi, prompted, finishPrompt: (e?: Error) => finishPrompt(e), finishDelete: (e?: Error) => finishDelete(e) };
  }
  const tick = () => new Promise<void>((r) => setImmediate(r));

  it.each(["resolves", "rejects"])("does not drain when the turn %s before deletion is acknowledged", async (outcome) => {
    const h = harness();
    await h.m.createSession("/tmp");
    await h.m.prompt("s-delete-rpc", [{ type: "text", text: "first" }]);
    await h.m.prompt("s-delete-rpc", [{ type: "text", text: "queued" }]);
    const deleting = h.m.deleteSession("s-delete-rpc");
    await tick();
    h.finishPrompt(outcome === "rejects" ? new Error("session deleted by agent") : undefined);
    await tick();
    try {
      expect(h.prompted).toEqual(["first"]);
    } finally {
      h.finishDelete();
      await deleting;
    }
    expect(readAllQueues()["s-delete-rpc"] ?? []).toEqual([]);
  });

  it("resumes the preserved queue if deletion fails after the turn ends", async () => {
    const h = harness();
    await h.m.createSession("/tmp");
    await h.m.prompt("s-delete-rpc", [{ type: "text", text: "first" }]);
    await h.m.prompt("s-delete-rpc", [{ type: "text", text: "queued" }]);
    const deleting = h.m.deleteSession("s-delete-rpc");
    const rejected = expect(deleting).rejects.toThrow("delete refused");
    await tick();
    h.finishPrompt();
    await tick();
    try {
      expect(h.prompted).toEqual(["first"]);
      expect(readAllQueues()["s-delete-rpc"]?.map((q) => q.blocks)).toEqual([[{ type: "text", text: "queued" }]]);
    } finally {
      h.finishDelete(new Error("delete refused"));
      await rejected;
    }
    await tick();
    expect(h.prompted).toEqual(["first", "queued"]);
    expect(h.m.getSession("s-delete-rpc")).toBeDefined();
  });

  it("holds an adopted session's queue when the daemon ends its turn during deletion", async () => {
    const h = harness();
    await h.m.createSession("/tmp");
    const s = h.m.getSession("s-delete-rpc")!;
    s.running = true;
    s.adopted = true;
    await h.m.prompt("s-delete-rpc", [{ type: "text", text: "queued" }]);
    const deleting = h.m.deleteSession("s-delete-rpc");
    await tick();
    h.mi.onNotification("_devin-web/turn_end", { sessionId: "s-delete-rpc" });
    try {
      expect(h.prompted).toEqual([]);
    } finally {
      h.finishDelete();
      await deleting;
      h.finishPrompt();
      await tick();
    }
  });

  it("rejects new prompts during deletion without adding them to the queue", async () => {
    const h = harness();
    await h.m.createSession("/tmp");
    const deleting = h.m.deleteSession("s-delete-rpc");
    await tick();
    try {
      await expect(h.m.prompt("s-delete-rpc", [{ type: "text", text: "late" }])).rejects.toThrow("being deleted");
      expect(h.prompted).toEqual([]);
    } finally {
      h.finishDelete();
      await deleting;
      h.finishPrompt();
      await tick();
    }
  });
});

it("persisted queue previews decode encoded mention paths", () => {
  writeSessionQueue("mention-uri-test", [{ id: "mention-q", mentionEncoding: "uri", blocks: [
    { type: "resource_link", name: "a #1.txt", uri: "file:///tmp/dw%20mention/a%20%231.txt" },
  ] }]);
  const m = stubbed();
  expect(m.queueState("mention-uri-test").queue[0].mentions).toEqual([
    { path: "/tmp/dw mention/a #1.txt", name: "a #1.txt" },
  ]);
});

it("legacy queue paths preserve literal percent escapes", () => {
  writeSessionQueue("legacy-mention-uri-test", [{ id: "old-mention-q", blocks: [
    { type: "resource_link", name: "100%20.txt", uri: "file:///tmp/100%20.txt" },
  ] }]);
  expect(stubbed().queueState("legacy-mention-uri-test").queue[0].mentions).toEqual([
    { path: "/tmp/100%20.txt", name: "100%20.txt" },
  ]);
});

it("editing an encoded queued mention restores its literal composer path", async () => {
  const m = stubbed();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (m as any).sessions.set("mention-edit", {
    sessionId: "mention-edit", cwd: "/tmp", running: true, loaded: true, attachedGen: 0, queue: [],
  });
  await m.prompt("mention-edit", [
    { type: "resource_link", name: "a #1.txt", uri: "file:///tmp/100%2520/a%20%231.txt" },
  ]);
  const queued = m.queueState("mention-edit").queue[0];
  const restored = blocksToDraft(m.dequeue("mention-edit", queued.id)!.blocks);
  expect(restored.mentions).toEqual([{ path: "/tmp/100%20/a #1.txt", name: "a #1.txt" }]);
});

describe("sent mention display paths", () => {
  const path = "/tmp/한 글/100%20 #1.txt";
  const encoded = { type: "resource_link" as const, name: "100%20 #1.txt", uri: pathToFileURL(path).href };

  it("shows the literal path in a direct prompt's assembled echo while sending its encoded URI", async () => {
    const m = stubbed();
    const sent: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitted = vi.spyOn(m as any, "emit");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async (_method: string, params: { prompt?: unknown }) => { if (params.prompt) sent.push(params.prompt); return {}; };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).sessions.set("mention-direct", {
      sessionId: "mention-direct", cwd: "/tmp", running: false, loaded: true, attachedGen: 0, queue: [],
    });
    await m.prompt("mention-direct", [encoded, { type: "text", text: "read" }]);
    expect(m.provisional("mention-direct")[0].mentions).toEqual([{ path, name: encoded.name }]);
    expect(sent).toEqual([[encoded, { type: "text", text: "read" }]]);
    expect((emitted.mock.calls.find(([, type, data]) => type === "session_update" && (data as { sessionUpdate?: string }).sessionUpdate === "user_message")?.[2] as { content: unknown }).content).toEqual(sent[0]);
    emitted.mockRestore();
  });

  it.each([
    ["encoded", "uri" as const, encoded, path],
    ["legacy", undefined, { type: "resource_link" as const, name: "100%20.txt", uri: "file:///tmp/100%20.txt" }, "/tmp/100%20.txt"],
  ])("keeps %s queue provenance through persistence and drain", async (kind, mentionEncoding, block, expectedPath) => {
    const sid = `sent-mention-${kind}`;
    writeSessionQueue(sid, [{ id: `q-${kind}`, blocks: [block], ...(mentionEncoding ? { mentionEncoding } : {}) }]);
    const m = stubbed();
    const sent: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitted = vi.spyOn(m as any, "emit");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async (_method: string, params: { prompt?: unknown }) => { if (params.prompt) sent.push(params.prompt); return {}; };
    await m.loadSession(sid, "/tmp");
    expect(m.provisional(sid)[0].mentions).toEqual([{ path: expectedPath, name: block.name }]);
    expect(sent).toEqual([[block]]);
    expect((emitted.mock.calls.find(([, type, data]) => type === "session_update" && (data as { sessionUpdate?: string }).sessionUpdate === "user_message")?.[2] as { content: unknown }).content).toEqual(sent[0]);
    emitted.mockRestore();
  });
});

describe("deleteSession lock guard", () => {
  const lockFile = (id: string, pid: number | null) => {
    const dir = join(DEVIN_CLI_DIR, "session_locks");
    mkdirSync(dir, { recursive: true });
    if (pid === null) rmSync(join(dir, `${id}.lock`), { force: true });
    else writeFileSync(join(dir, `${id}.lock`), `${pid}\n`);
  };
  const loaded = (m: SessionManager, id: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    mi.sessions.set(id, {
      sessionId: id, cwd: "/tmp", running: false, loaded: true,
      attachedGen: mi.generation, queue: [],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async () => ({});
  };

  it("refuses to delete while a live foreign process holds the lock", async () => {
    // this process's pid is alive and not the acp agent's — exactly the
    // foreign-holder shape (pid 1 won't do: kill(0) on it fails EPERM,
    // which lockOwner correctly treats as unreachable/dead)
    lockFile("s-flock", process.pid);
    const m = stubbed();
    loaded(m, "s-flock");
    let called = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async () => { called = true; return {}; };
    await expect(m.deleteSession("s-flock")).rejects.toBeInstanceOf(LockedSessionError);
    expect(called).toBe(false); // the delete RPC must never fire
    lockFile("s-flock", null);
  });

  it("deletes normally when the lock holder is dead", async () => {
    lockFile("s-stale", 4194303); // pid_max on stock linux is 4,194,304 — always dead
    const m = stubbed();
    loaded(m, "s-stale");
    await expect(m.deleteSession("s-stale")).resolves.toBeTruthy();
  });

  it("deletes normally when no lock file exists", async () => {
    lockFile("s-free", null);
    const m = stubbed();
    loaded(m, "s-free");
    await expect(m.deleteSession("s-free")).resolves.toBeTruthy();
  });
});
