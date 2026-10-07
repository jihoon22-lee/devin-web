import { describe, expect, it } from "vitest";
import { AcpBridge } from "../lib/acp/bridge";

const MISSING = "definitely-not-a-devin-binary";

function bridgeWithExits() {
  const exits: [number | null, string | null][] = [];
  const b = new AcpBridge(
    {
      onSessionUpdate() {},
      onNotification() {},
      onClientRequest() {},
      onExit: (code, signal) => exits.push([code, signal]),
    },
    [],
    MISSING,
  );
  return { b, exits };
}

describe("AcpBridge spawn failure", () => {
  it("rejects ensure() instead of crashing the process", async () => {
    const { b, exits } = bridgeWithExits();
    await expect(b.ensure()).rejects.toThrow(`failed to run ${MISSING}`);
    expect(exits).toEqual([[null, null]]);
    expect(b.running).toBe(false);
  });

  it("allows a later retry (ready promise is reset)", async () => {
    const { b, exits } = bridgeWithExits();
    await expect(b.ensure()).rejects.toThrow(/ENOENT/);
    await expect(b.ensure()).rejects.toThrow(/ENOENT/);
    expect(exits).toHaveLength(2);
  });
});

describe("AcpBridge init-timeout cleanup", () => {
  // `grep acp` reads stdin forever and never replies — initialize times out
  // while the child stays alive. start() must kill it so it can't outlive
  // its replacement or later reject another generation's requests.
  it("kills a spawned child whose initialize times out", async () => {
    const exits: unknown[] = [];
    const b = new AcpBridge(
      { onSessionUpdate() {}, onNotification() {}, onClientRequest() {}, onExit: (c, s) => exits.push([c, s]) },
      [],
      "grep",
      60,
    );
    const first = b.ensure();
    // the connector is async — let start() assign this.proc before reading it
    await new Promise((r) => setImmediate(r));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pid1 = (b as any).proc?.pid as number;
    expect(pid1).toBeGreaterThan(0);
    await expect(first).rejects.toThrow(/timed out/);
    expect(b.running).toBe(false);
    // the abandoned child must actually be dead, not just detached
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(pid1, 0);
        await new Promise((r) => setTimeout(r, 25));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
    // init failure is not an agent_exit — nothing was ever running
    expect(exits).toEqual([]);
    // retry spawns a fresh child (also times out) instead of reusing the orphan
    await expect(b.ensure()).rejects.toThrow(/timed out/);
    expect(exits).toEqual([]);
  }, 10_000);
});

describe("AcpBridge.request guards", () => {
  const mk = () =>
    new AcpBridge(
      { onSessionUpdate() {}, onNotification() {}, onClientRequest() {}, onExit() {} },
      [],
      MISSING,
    );

  it("rejects immediately when stdin is not writable", async () => {
    const b = mk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b as any).proc = { stdin: { writable: false } };
    await expect(b.request("session/list")).rejects.toThrow(/not running/);
  });

  it("rejects immediately with no child at all", async () => {
    const b = mk();
    await expect(b.request("session/list")).rejects.toThrow(/not running/);
  });

  it("times out a request the agent never answers", async () => {
    const b = mk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b as any).proc = { stdin: { writable: true, write: () => true } };
    await expect(b.request("session/list", {}, { timeoutMs: 50 })).rejects.toThrow(/timed out/);
  });

  it("timeoutMs:0 disables the ceiling (session/prompt)", async () => {
    const b = mk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b as any).proc = { stdin: { writable: true, write: () => true } };
    const p = b.request("session/prompt", {}, { timeoutMs: 0 });
    p.catch(() => {}); // stays pending — must not reject on its own
    const settled = await Promise.race([
      p.then(() => "resolved", () => "rejected"),
      new Promise((r) => setTimeout(() => r("pending"), 120)),
    ]);
    expect(settled).toBe("pending");
  });

  it("a bare {id} ack — neither result nor error — still resolves the request", async () => {
    const b = mk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = b as any;
    mi.proc = { stdin: { writable: true, write: () => true } };
    // a timeoutMs:0 call has no ceiling: a dropped response leaves it (and
    // the session's running flag) stuck forever
    const p = b.request("session/prompt", {}, { timeoutMs: 0 });
    p.catch(() => {});
    mi.dispatch({ jsonrpc: "2.0", id: 1 });
    const settled = await Promise.race([
      p.then(() => "resolved", () => "rejected"),
      new Promise((r) => setTimeout(() => r("pending"), 60)),
    ]);
    expect(settled).toBe("resolved");
    // error-only responses still reject through the same path
    const p2 = b.request("session/list").then(
      () => "resolved",
      (e: Error) => e.message,
    );
    mi.dispatch({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "nope" } });
    expect(await p2).toBe("nope");
    // and a response for an unknown id is dropped, not misrouted
    mi.dispatch({ jsonrpc: "2.0", id: 999, result: {} });
  });
});

describe("ACP UTF-8 transport", () => {
  it("preserves Korean and emoji at every byte boundary", async () => {
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");
    const proc = Object.assign(new EventEmitter(), {
      pid: 123, exitCode: null, stdout: new PassThrough(), stdin: new PassThrough(), stderr: new PassThrough(),
      kill: () => { proc.emit("exit", 0, null); },
    });
    proc.stdin.on("data", (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === "initialize") queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: msg.id, result: { protocolVersion: 1 } }) + "\n"));
    });
    const texts: string[] = [];
    const b = new AcpBridge({
      onSessionUpdate(n) { texts.push((n.update as { content: { text: string } }).content.text); },
      onNotification() {}, onClientRequest() {}, onExit() {},
    }, [], "fake", 1000, async () => proc);
    try {
      await b.ensure();
      const text = "한글🙂";
      const wire = Buffer.from(JSON.stringify({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } }) + "\n");
      for (const byte of wire) proc.stdout.write(Buffer.from([byte]));
      expect(texts).toEqual([text]);
    } finally { b.kill(); }
  });
});


describe("daemon request identity", () => {
  it("consumes identities once and only for the matching session and typed wire ID", () => {
    const events: import("../lib/acp/bridge").ClientRequestEvent[] = [];
    const b = new AcpBridge({ onSessionUpdate() {}, onNotification() {}, onExit() {}, onClientRequest: (event) => events.push(event) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispatch = (msg: object) => (b as any).dispatch(msg);
    const request = (id: string | number, sessionId = "s") => dispatch({ id, method: "session/request_permission", params: { sessionId } });
    const id = `req-${"a".repeat(32)}`;
    const identity = { method: "_devin-web/request_identity", params: { rpcId: 9, sessionId: "s", method: "session/request_permission", requestId: id } };
    dispatch(identity); request("9"); request(9, "other"); request(9); request(9);
    dispatch(identity); request(9); // replay supplies the same identity again
    expect(events.map((event) => event.requestId)).toEqual([undefined, undefined, id, undefined, id]);
  });
});
