import { describe, expect, it, vi } from "vitest";
import { signalName, utf8Boundary, localPool as terminalPool, USER_IDLE_MS, EXITED_TTL_MS } from "../lib/acp/terminal";

describe("signalName (ACP WaitForTerminalExit expects string|null)", () => {
  it("maps numbers to POSIX signal names", () => {
    expect(signalName(15)).toBe("SIGTERM");
    expect(signalName(9)).toBe("SIGKILL");
    expect(signalName(2)).toBe("SIGINT");
  });

  it("returns null for normal exit", () => {
    expect(signalName(0)).toBeNull();
    expect(signalName(null)).toBeNull();
    expect(signalName(undefined)).toBeNull();
  });

  it("falls back for unknown numbers", () => {
    expect(signalName(28)).toBe("SIG28");
  });
});

describe("utf8Boundary (E8 — byte offsets must stay true)", () => {
  it("advances a mid-sequence cut to the next sequence start", () => {
    const b = Buffer.from("a한b", "utf8"); // 1 + 3 + 1 bytes
    // cutting inside the 3-byte '한' would decode to U+FFFD
    expect(utf8Boundary(b, 2)).toBe(4);
    expect(utf8Boundary(b, 3)).toBe(4);
    expect(b.subarray(utf8Boundary(b, 2)).toString("utf8")).toBe("b");
  });

  it("leaves an aligned cut alone and never exceeds the buffer", () => {
    const b = Buffer.from("a한b", "utf8");
    expect(utf8Boundary(b, 1)).toBe(1);
    expect(utf8Boundary(b, 5)).toBe(5);
    expect(utf8Boundary(b, 10)).toBe(10);
  });

  it("snapshot() keeps byte offsets exact across a mid-sequence `since`", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const terms = () => (terminalPool as any).terms as Map<string, any>;
    // output ends 'a한b'; cursor lands inside '한' (offset 1..3 of the tail)
    terms().set("t-utf8", {
      pty: null, output: "xa한b", outputBytes: 5, baseOffset: 10,
      truncated: false, exitCode: null, signal: null, exited: false,
      exitedAt: null, waiters: [], outputByteLimit: 1024,
      listeners: new Set(), eventListeners: new Set(), inputSeq: new Map(),
      sessionId: "s", cwd: "/tmp", label: "sh", createdAt: Date.now(),
      user: true, lastActivity: Date.now(),
    });
    // "xa한b" is 6 bytes: x|a|한(3)|b — since=13 lands inside '한' (bytes 12-14)
    const snap = terminalPool.snapshot("t-utf8", 13);
    // must not emit U+FFFD — offset advances to the next boundary instead
    expect(snap!.output).toBe("b");
    expect(snap!.offset).toBe(15);
    expect(snap!.offset + Buffer.byteLength(snap!.output, "utf8")).toBe(16);
    terms().delete("t-utf8");
  });
});

describe("idle user-shell reaping", () => {
  // inject fake entries directly — create() needs node-pty which vitest lacks
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const terms = () => (terminalPool as any).terms as Map<string, any>;
  const fake = (over: Record<string, unknown> = {}) => ({
    pty: { kill: vi.fn(), write: vi.fn(), resize: vi.fn() },
    output: "",
    outputBytes: 0,
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
    sessionId: "s",
    cwd: "/tmp",
    label: "sh",
    createdAt: Date.now(),
    user: true,
    lastActivity: Date.now() - USER_IDLE_MS - 1000, // past the idle window
    ...over,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reap = () => (terminalPool as any).reapIdle.call(terminalPool);

  it("reaps an idle user shell and leaves a notice in the tombstone", () => {
    const e = fake();
    const kill = e.pty.kill; // release() nulls e.pty — capture the mock first
    terms().set("t-idle", e);
    reap();
    expect(kill).toHaveBeenCalled();
    expect(e.exited).toBe(true);
    expect(e.output).toContain("idle shell closed");
    terms().delete("t-idle");
  });

  it("keeps a user shell with recent activity", () => {
    const e = fake({ lastActivity: Date.now() });
    terms().set("t-active", e);
    reap();
    expect(e.pty.kill).not.toHaveBeenCalled();
    terms().delete("t-active");
  });

  it("keeps an idle user shell while a viewer is attached", () => {
    const e = fake({ listeners: new Set([() => {}]) });
    terms().set("t-watched", e);
    reap();
    expect(e.pty.kill).not.toHaveBeenCalled();
    terms().delete("t-watched");
  });

  it("keeps an idle user shell the user pinned, and lists the pin", () => {
    const e = fake({ keep: false });
    terms().set("t-kept", e);
    terminalPool.setKeep("t-kept", true);
    reap();
    expect(e.pty.kill).not.toHaveBeenCalled();
    expect(terminalPool.list("s").find((t) => t.id === "t-kept")).toMatchObject({ keep: true, idleMs: USER_IDLE_MS });
    terminalPool.setKeep("t-kept", false);
    reap();
    expect(e.exited).toBe(true);
    terms().delete("t-kept");
  });

  it("never reaps agent (ACP) terminals even when idle", () => {
    const e = fake({ user: false });
    terms().set("t-agent", e);
    reap();
    expect(e.pty.kill).not.toHaveBeenCalled();
    terms().delete("t-agent");
  });

  it("skips already-exited entries", () => {
    const e = fake({ exited: true, pty: null });
    terms().set("t-dead", e);
    reap();
    expect(e.output).not.toContain("idle shell closed");
    terms().delete("t-dead");
  });

  it("releases an exited agent terminal the agent never released", () => {
    const e = fake({
      user: false,
      exited: true,
      exitedAt: Date.now() - EXITED_TTL_MS - 1000,
      // pty still set — agent never called terminal/release
    });
    terms().set("t-unreleased", e);
    reap();
    expect(e.pty).toBeNull(); // released → tombstone
    terms().delete("t-unreleased");
  });

  it("keeps a recently-exited terminal (agent may still be reading it)", () => {
    const e = fake({ user: false, exited: true, exitedAt: Date.now() });
    terms().set("t-fresh-exit", e);
    reap();
    expect(e.pty).not.toBeNull();
    terms().delete("t-fresh-exit");
  });

  it("keeps an old exited terminal while a viewer is attached", () => {
    const e = fake({
      user: false,
      exited: true,
      exitedAt: Date.now() - EXITED_TTL_MS - 1000,
      listeners: new Set([() => {}]),
    });
    terms().set("t-watched-exit", e);
    reap();
    expect(e.pty).not.toBeNull();
    terms().delete("t-watched-exit");
  });
});

describe("atomic attach / byte-offset resync (3-x)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const terms = () => (terminalPool as any).terms as Map<string, any>;
  const fake = (over: Record<string, unknown> = {}) => ({
    pty: { kill: vi.fn(), write: vi.fn(), resize: vi.fn() },
    output: "hello world",
    outputBytes: 11,
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
    sessionId: "s",
    cwd: "/tmp",
    label: "sh",
    createdAt: Date.now(),
    user: true,
    lastActivity: Date.now(),
    ...over,
  });

  it("attach returns the snapshot and registers listeners in one step", () => {
    const e = fake();
    terms().set("t-a", e);
    const data: [string, number][] = [];
    const snap = terminalPool.attach("t-a", (d, off) => data.push([d, off]), () => {});
    expect(snap).toMatchObject({ output: "hello world", offset: 0, resynced: false });
    expect(e.listeners.size).toBe(1);
    expect(e.eventListeners.size).toBe(1);
    terms().delete("t-a");
  });

  it("attach with `since` replays only the missed tail", () => {
    terms().set("t-b", fake());
    const snap = terminalPool.attach("t-b", () => {}, () => {}, 6);
    expect(snap).toMatchObject({ output: "world", offset: 6 });
    terms().delete("t-b");
  });

  it("a cursor older than baseOffset gets a full resync instead of a hole", () => {
    terms().set("t-c", fake({ output: "tail", outputBytes: 4, baseOffset: 500 }));
    const snap = terminalPool.attach("t-c", () => {}, () => {}, 50);
    expect(snap).toMatchObject({ output: "tail", resynced: true });
    terms().delete("t-c");
  });

  it("snapshot() resyncs without adding listeners", () => {
    const e = fake();
    terms().set("t-d", e);
    const s = terminalPool.snapshot("t-d", 6);
    expect(s).toMatchObject({ output: "world", offset: 6 });
    expect(e.listeners.size).toBe(0);
    terms().delete("t-d");
  });

  it("marks tail-only snapshots as partial", () => {
    terms().set("t-p", fake());
    expect(terminalPool.snapshot("t-p", 6)).toMatchObject({ output: "world", offset: 6, partial: true });
    expect(terminalPool.snapshot("t-p", 0)).toMatchObject({ output: "hello world", offset: 0, partial: false });
    expect(terminalPool.snapshot("t-p")).toMatchObject({ output: "hello world", partial: false });
    terms().delete("t-p");
  });

  it("dismiss hides a closed terminal but keeps its output for the agent", () => {
    const e = fake();
    terms().set("t-dis", e);
    terminalPool.dismiss("t-dis");
    expect(e.pty).toBeNull(); // released
    expect(terminalPool.list().some((t) => t.id === "t-dis")).toBe(false);
    expect(terminalPool.output("t-dis").output).toContain("hello world");
    terms().delete("t-dis");
  });

  it("detach removes both listeners", () => {
    const e = fake();
    terms().set("t-e", e);
    const onData = () => {};
    const onEvent = () => {};
    terminalPool.attach("t-e", onData, onEvent);
    terminalPool.detach("t-e", onData, onEvent);
    expect(e.listeners.size).toBe(0);
    expect(e.eventListeners.size).toBe(0);
    terms().delete("t-e");
  });

  it("release emits a released event to attached listeners", () => {
    const e = fake();
    terms().set("t-f", e);
    const events: string[] = [];
    terminalPool.attach("t-f", () => {}, (ev) => events.push(ev.type));
    terminalPool.release("t-f");
    expect(events).toEqual(["released"]);
    expect(e.pty).toBeNull();
    terms().delete("t-f");
  });
});

describe("ordered terminal input (3-x)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const terms = () => (terminalPool as any).terms as Map<string, any>;
  const fake = () => ({
    pty: { kill: vi.fn(), write: vi.fn(), resize: vi.fn() },
    output: "",
    outputBytes: 0,
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
    sessionId: "s",
    cwd: "/tmp",
    label: "sh",
    createdAt: Date.now(),
    user: true,
    lastActivity: Date.now(),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const writes = (e: any) => e.pty.write.mock.calls.map((c: any[]) => c[0]).join("");

  it("applies in-order input immediately", () => {
    const e = fake();
    terms().set("t-i1", e);
    terminalPool.write("t-i1", "a", "conn", 1);
    terminalPool.write("t-i1", "b", "conn", 2);
    expect(writes(e)).toBe("ab");
    terms().delete("t-i1");
  });

  it("buffers out-of-order input and flushes in seq order", () => {
    const e = fake();
    terms().set("t-i2", e);
    terminalPool.write("t-i2", "c", "conn", 3); // arrives first — buffered
    terminalPool.write("t-i2", "a", "conn", 1);
    terminalPool.write("t-i2", "b", "conn", 2); // completes 1,2,3 → flush
    expect(writes(e)).toBe("abc");
    terms().delete("t-i2");
  });

  it("drops duplicate sequence numbers", () => {
    const e = fake();
    terms().set("t-i3", e);
    terminalPool.write("t-i3", "a", "conn", 1);
    terminalPool.write("t-i3", "a", "conn", 1); // retry — must not double-type
    terminalPool.write("t-i3", "b", "conn", 2);
    expect(writes(e)).toBe("ab");
    terms().delete("t-i3");
  });

  it("flushes a gap after the timeout instead of jamming forever", async () => {
    vi.useFakeTimers();
    try {
      const e = fake();
      terms().set("t-i4", e);
      terminalPool.write("t-i4", "a", "conn", 1);
      terminalPool.write("t-i4", "c", "conn", 3); // seq 2 lost — buffered
      expect(writes(e)).toBe("a");
      await vi.advanceTimersByTimeAsync(200);
      expect(writes(e)).toBe("ac"); // gap skipped, input unblocked
      // and the seq counter moved past the hole so later input isn't stuck
      terminalPool.write("t-i4", "d", "conn", 4);
      expect(writes(e)).toBe("acd");
      terms().delete("t-i4");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sequences are independent per connection", () => {
    const e = fake();
    terms().set("t-i5", e);
    terminalPool.write("t-i5", "x", "connA", 1);
    terminalPool.write("t-i5", "y", "connB", 1); // separate counter — not buffered
    expect(writes(e)).toBe("xy");
    terms().delete("t-i5");
  });

  it("unsequenced writes still pass straight through", () => {
    const e = fake();
    terms().set("t-i6", e);
    terminalPool.write("t-i6", "raw");
    expect(writes(e)).toBe("raw");
    terms().delete("t-i6");
  });
});

describe("release() waiters + dismiss() safety", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const terms = () => (terminalPool as any).terms as Map<string, any>;
  const fake = (over: Record<string, unknown> = {}) => ({
    pty: { kill: vi.fn(), write: vi.fn(), resize: vi.fn() },
    output: "out",
    outputBytes: 3,
    baseOffset: 0,
    truncated: false,
    exitCode: null,
    signal: null,
    exited: false,
    exitedAt: null,
    waiters: [] as ((r: { exitCode: number | null; signal: string | null }) => void)[],
    outputByteLimit: 1024,
    listeners: new Set(),
    eventListeners: new Set(),
    inputSeq: new Map(),
    sessionId: "s",
    cwd: "/tmp",
    label: "sh",
    createdAt: Date.now(),
    user: false,
    lastActivity: Date.now(),
    dismissed: undefined as boolean | undefined,
    ...over,
  });

  it("release resolves pending wait_for_exit instead of hanging the agent", async () => {
    const e = fake({ user: false });
    terms().set("t-rel", e);
    const waiter = terminalPool.waitForExit("t-rel");
    terminalPool.release("t-rel");
    await expect(waiter).resolves.toEqual({ exitCode: null, signal: null });
    terms().delete("t-rel");
  });

  it("wait_for_exit on an already-released terminal resolves immediately", async () => {
    const e = fake({ exited: true, exitCode: 0, pty: null });
    terms().set("t-dead", e);
    await expect(terminalPool.waitForExit("t-dead")).resolves.toEqual({ exitCode: 0, signal: null });
    terms().delete("t-dead");
  });

  it("dismiss hides a live agent terminal without killing its process", () => {
    const e = fake({ user: false });
    terms().set("t-agent", e);
    terminalPool.dismiss("t-agent");
    expect(e.pty.kill).not.toHaveBeenCalled(); // agent's process survives
    expect(e.pty).not.toBeNull(); // not released
    expect(e.dismissed).toBe(true);
    terms().delete("t-agent");
  });

  it("dismiss still releases an exited agent terminal (tombstone)", () => {
    const e = fake({ user: false, exited: true });
    terms().set("t-exited", e);
    terminalPool.dismiss("t-exited");
    expect(e.pty).toBeNull(); // released → tombstone
    expect(e.dismissed).toBe(true);
    terms().delete("t-exited");
  });

  it("dismiss kills a user shell as before", () => {
    const e = fake({ user: true });
    const kill = e.pty.kill;
    terms().set("t-user", e);
    terminalPool.dismiss("t-user");
    expect(kill).toHaveBeenCalled();
    expect(e.dismissed).toBe(true);
    terms().delete("t-user");
  });
});

describe("resize ownership claim (E7)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const terms = () => (terminalPool as any).terms as Map<string, any>;

  it("a non-owner's resize is ignored until it claims ownership", () => {
    const resize = vi.fn();
    terms().set("t-claim", { pty: { resize }, viewers: ["phone", "desk"], inputSeq: new Map() });

    terminalPool.resize("t-claim", 200, 50, "desk");
    expect(resize).not.toHaveBeenCalled();

    void terminalPool.claimResize("t-claim", "desk");
    terminalPool.resize("t-claim", 200, 50, "desk");
    expect(resize).toHaveBeenCalledWith(200, 50);

    terms().delete("t-claim");
  });
});
