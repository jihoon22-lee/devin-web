import { describe, expect, it, afterEach, vi } from "vitest";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../lib/acp/daemon.mjs";

const FAKE_ACP = new URL("./fixtures/fake-acp.mjs", import.meta.url).pathname;
const enc = (m: object) => JSON.stringify(m) + "\n";

function rpcClient(sockPath: string) {
  const sock = connect(sockPath);
  const lines: string[] = [];
  let buf = "";
  const waiters: { pred: (l: string) => boolean; res: (l: string) => void }[] = [];
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      lines.push(line);
      for (let w = waiters.length - 1; w >= 0; w--) {
        if (waiters[w].pred(line)) {
          waiters[w].res(line);
          waiters.splice(w, 1);
        }
      }
    }
  });
  const waitFor = (pred: (l: string) => boolean, ms = 3000) => {
    const hit = lines.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout waiting for line")), ms);
      waiters.push({ pred, res: (l) => { clearTimeout(t); res(l); } });
    });
  };
  return {
    sock,
    lines,
    send: (m: object) => sock.write(enc(m)),
    raw: (s: string) => sock.write(s),
    waitFor,
    close: () => sock.destroy(),
  };
}

let daemons: { stop: () => Promise<void> }[] = [];
let dirs: string[] = [];

afterEach(async () => {
  for (const d of daemons) await d.stop();
  daemons = [];
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function startDaemon(opts: Record<string, unknown> = {}) {
  const dir = (opts.dir as string) ?? (await mkdtemp(join(tmpdir(), "acpd-test-")));
  dirs.push(dir);
  const sockPath = join(dir, "acp.sock");
  const daemonOpts = { ...opts };
  delete daemonOpts.dir;
  const daemon = createDaemon({
    sockPath,
    cmd: [process.execPath, FAKE_ACP],
    ...daemonOpts,
  });
  await daemon.start();
  daemons.push(daemon);
  return { daemon, sockPath, dir };
}

describe("devin-acpd", () => {
  it("passes initialize through to acp, then caches it for later clients", async () => {
    const { sockPath } = await startDaemon();
    const c1 = rpcClient(sockPath);
    c1.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r1 = JSON.parse(await c1.waitFor((l) => l.includes('"id":1')));
    expect(r1.result.fakeInit).toBe(true);
    c1.close();

    // second client gets the cached response — identical result, no new gen
    const c2 = rpcClient(sockPath);
    c2.send({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} });
    const r2 = JSON.parse(await c2.waitFor((l) => l.includes('"id":7')));
    expect(r2.result.fakeInit).toBe(true);
    c2.close();
  });

  it("forwards requests verbatim and tracks loaded sessions", async () => {
    const { daemon, sockPath } = await startDaemon();
    const c = rpcClient(sockPath);
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c.waitFor((l) => l.includes('"id":1'));
    c.send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "sess-A", cwd: "/x" } });
    const r = JSON.parse(await c.waitFor((l) => l.includes('"id":2')));
    expect(r.result.modes.currentModeId).toBe("plan");
    // daemon tracked the loaded session
    expect([...daemon.loadedSessions.keys()]).toContain("sess-A");
    c.close();
  });

  it("buffers agent notifications while no client and replays after initialize", async () => {
    const { sockPath } = await startDaemon();
    const c1 = rpcClient(sockPath);
    c1.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c1.waitFor((l) => l.includes('"id":1'));
    c1.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
    await c1.waitFor((l) => l.includes('"id":2'));

    // agent pushes a notification AFTER the client is gone (delayed emit)
    const update = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-fake-1", update: { kind: "text", text: "hello" } } });
    c1.send({ jsonrpc: "2.0", method: "TEST_EMIT", params: { line: update, delayMs: 250 } });
    c1.close();
    await new Promise((r) => setTimeout(r, 450));

    // reconnecting client: cached init + replay of the buffered update
    const c2 = rpcClient(sockPath);
    c2.send({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} });
    const replayed = await c2.waitFor((l) => l.includes('"hello"'));
    expect(JSON.parse(replayed).method).toBe("session/update");
    c2.close();
  });

  it("sends _devin-web/flushed with session ids after replaying buffered notifications", async () => {
    // restart-during-turn dup fix: the web re-seeds the listed sessions once
    // the replay burst ends, so content that double-rendered behind a
    // mid-replay guard reset converges back — the marker must land strictly
    // AFTER the replayed lines
    const { sockPath } = await startDaemon();
    const c1 = rpcClient(sockPath);
    c1.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c1.waitFor((l) => l.includes('"id":1'));
    const update = JSON.stringify({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "s-x", update: { sessionUpdate: "user_message", content: [{ type: "text", text: "q" }] } },
    });
    c1.send({ jsonrpc: "2.0", method: "TEST_EMIT", params: { line: update, delayMs: 250 } });
    c1.close();
    await new Promise((r) => setTimeout(r, 450));

    const c2 = rpcClient(sockPath);
    c2.send({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} });
    const replayed = await c2.waitFor((l) => l.includes('"user_message"'));
    const marker = await c2.waitFor((l) => l.includes("_devin-web/flushed"));
    expect(c2.lines.indexOf(marker)).toBeGreaterThan(c2.lines.indexOf(replayed));
    expect(JSON.parse(marker).params.sessions).toContain("s-x");
    c2.close();
  });

  it("cancels a permission request after the grace window when disconnected", async () => {
    const { sockPath } = await startDaemon({ requestGraceMs: 200 });
    const c1 = rpcClient(sockPath);
    c1.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c1.waitFor((l) => l.includes('"id":1'));
    c1.close();
    await new Promise((r) => setTimeout(r, 100));

    // agent asks permission with no client connected → held → after the grace
    // window the daemon itself answers acp with the protocol cancel; the fake
    // acp echoes that response back as TEST_OBSERVED for us to inspect
    const perm = JSON.stringify({ jsonrpc: "2.0", id: 55, method: "session/request_permission", params: { sessionId: "s1", toolCall: { id: "t1" } } });
    const c2 = rpcClient(sockPath);
    c2.send({ jsonrpc: "2.0", method: "TEST_EMIT", params: { line: perm } });
    await new Promise((r) => setTimeout(r, 500));
    const c3 = rpcClient(sockPath);
    c3.send({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} });
    // the observed cancel response is replayed from the buffer
    const observed = JSON.parse(await c3.waitFor((l) => l.includes("TEST_OBSERVED")));
    expect(observed.params.original.id).toBe(55);
    expect(observed.params.original.result).toEqual({ outcome: { outcome: "cancelled" } });
    // and the original request must NOT be replayed (already answered)
    await new Promise((r) => setTimeout(r, 150));
    expect(c3.lines.some((l) => l.includes('"method":"session/request_permission"'))).toBe(false);
    c2.close();
    c3.close();
  });



  it("notifies and drops the old client when a replacement speaks", async () => {
    const { sockPath } = await startDaemon();
    const c1 = rpcClient(sockPath);
    c1.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c1.waitFor((l) => l.includes('"id":1'));
    const c2 = rpcClient(sockPath);
    c2.send({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} });
    const replaced = await c1.waitFor((l) => l.includes("_devin-web/replaced"));
    expect(JSON.parse(replaced).method).toBe("_devin-web/replaced");
    c2.close();
  });

  it("a bare connect (probe) does NOT displace the live client", async () => {
    const { daemon, sockPath } = await startDaemon();
    const c1 = rpcClient(sockPath);
    c1.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c1.waitFor((l) => l.includes('"id":1'));
    // silent probe — connects and disconnects without sending anything
    const clientBefore = daemon._test.client;
    const probe = connect(sockPath);
    await new Promise((r) => probe.once("connect", r));
    probe.destroy();
    await new Promise((r) => setTimeout(r, 150));
    // live client untouched — it still gets answers, no "replaced" was sent
    expect(daemon._test.client).toBe(clientBefore);
    expect(c1.lines.some((l) => l.includes("_devin-web/replaced"))).toBe(false);
    c1.send({ jsonrpc: "2.0", id: 2, method: "_devin-web/shim_info", params: {} });
    const info = JSON.parse(await c1.waitFor((l) => l.includes('"id":2')));
    expect(info.result.acpAlive).toBe(true);
    c1.close();
  });

  it("answers shim_info and shim_state locally", async () => {
    const { sockPath } = await startDaemon();
    const c = rpcClient(sockPath);
    c.send({ jsonrpc: "2.0", id: 1, method: "_devin-web/shim_info", params: {} });
    const info = JSON.parse(await c.waitFor((l) => l.includes('"id":1')));
    expect(info.result.acpAlive).toBe(true);
    expect(info.result.acpPid).toBeGreaterThan(0);
    c.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
    await c.waitFor((l) => l.includes('"id":2'));
    c.send({ jsonrpc: "2.0", id: 3, method: "session/new", params: {} });
    await c.waitFor((l) => l.includes('"id":3'));
    c.send({ jsonrpc: "2.0", id: 4, method: "_devin-web/shim_state", params: {} });
    const st = JSON.parse(await c.waitFor((l) => l.includes('"id":4')));
    expect(st.result.sessions.map((s: { sessionId: string }) => s.sessionId)).toContain("s-fake-1");
    c.close();
  });

  it("tracks busy sessions via session/prompt and synthesizes turn_end", async () => {
    const { sockPath } = await startDaemon();
    const c = rpcClient(sockPath);
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c.waitFor((l) => l.includes('"id":1'));
    c.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
    await c.waitFor((l) => l.includes('"id":2'));
    // deferred prompt response → session stays busy while the turn runs
    c.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s-fake-1", _defer: true, prompt: [] } });
    await new Promise((r) => setTimeout(r, 80));
    c.send({ jsonrpc: "2.0", id: 4, method: "_devin-web/shim_state", params: {} });
    const st1 = JSON.parse(await c.waitFor((l) => l.includes('"id":4')));
    expect(st1.result.sessions.find((s: { sessionId: string }) => s.sessionId === "s-fake-1").busy).toBe(true);
    // turn finishes → response flows → busy clears + synthesized turn_end
    c.send({ jsonrpc: "2.0", method: "TEST_FLUSH", params: {} });
    const te = JSON.parse(await c.waitFor((l) => l.includes("_devin-web/turn_end")));
    expect(te.params.sessionId).toBe("s-fake-1");
    c.send({ jsonrpc: "2.0", id: 5, method: "_devin-web/shim_state", params: {} });
    const st2 = JSON.parse(await c.waitFor((l) => l.includes('"id":5')));
    expect(st2.result.sessions.find((s: { sessionId: string }) => s.sessionId === "s-fake-1").busy).toBe(false);
    c.close();
  });

  it("respawns acp after an unexpected exit and drops the client", async () => {
    const { daemon, sockPath } = await startDaemon({ respawnBackoffMs: [50] });
    const c = rpcClient(sockPath);
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c.waitFor((l) => l.includes('"id":1'));
    const pid = daemon.info().acpPid;
    process.kill(pid!, "SIGKILL");
    // client socket gets closed by the daemon
    await new Promise<void>((res) => c.sock.on("close", res));
    // respawn happens after the (shortened) backoff — info flips to a new pid
    await new Promise((r) => setTimeout(r, 500));
    expect(daemon.info().acpAlive).toBe(true);
    expect(daemon.info().acpPid).not.toBe(pid);
  });

  it("D1: a client drop resumes a paused stdout (backpressure must not wedge the agent)", async () => {
    const { daemon, sockPath } = await startDaemon();
    const c = rpcClient(sockPath);
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c.waitFor((l) => l.includes('"id":1'));
    // simulate the write-backpressure path: stdout paused waiting for drain
    daemon._test.acp.proc.stdout.pause();
    expect(daemon._test.acp.proc.stdout.isPaused()).toBe(true);
    c.close();
    await new Promise((r) => setTimeout(r, 100));
    // dropClient must un-pause — the dead socket's drain never fires
    expect(daemon._test.acp.proc.stdout.isPaused()).toBe(false);
  });

  it("backpressure re-arms at most ONE drain listener per socket", async () => {
    const { daemon, sockPath } = await startDaemon();
    const c = rpcClient(sockPath);
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c.waitFor((l) => l.includes('"id":1'));
    // force every daemon->client write down the backpressure path — without
    // the _dwDrain guard each backed-up write adds ANOTHER drain listener
    // (>10 trips MaxListeners and piles up on slow clients)
    const sock = daemon._test.client.sock;
    sock.write = () => false;
    const notif = (t: string) =>
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-bp", update: { kind: "text", text: t } } });
    for (let i = 0; i < 15; i++)
      c.send({ jsonrpc: "2.0", method: "TEST_EMIT", params: { line: notif(`bp-${i}`) } });
    await new Promise((r) => setTimeout(r, 500));
    expect(sock.listenerCount("drain")).toBe(1);
    expect(daemon._test.acp.proc.stdout.isPaused()).toBe(true);
    c.close();
  });

  it("replays the same request identity, but gives a reused settled RPC id a new identity", async () => {
    const { sockPath } = await startDaemon();
    const c1 = rpcClient(sockPath);
    c1.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c1.waitFor((line) => line.includes('"id":1'));
    const request = JSON.stringify({ jsonrpc: "2.0", id: 771, method: "session/request_permission", params: { sessionId: "s" } });
    c1.send({ jsonrpc: "2.0", method: "TEST_EMIT", params: { line: request } });
    const first = JSON.parse(await c1.waitFor((line) => line.includes('"_devin-web/request_identity"')));
    expect(first.params.requestId).toMatch(/^req-[a-f0-9]{32}$/);
    await c1.waitFor((line) => line === request);
    c1.close();
    const c2 = rpcClient(sockPath);
    c2.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
    await c2.waitFor((line) => line === request);
    const replay = JSON.parse(c2.lines.find((line) => line.includes('"_devin-web/request_identity"'))!);
    expect(replay.params.requestId).toBe(first.params.requestId);
    expect(c2.lines.indexOf(JSON.stringify(replay))).toBeLessThan(c2.lines.indexOf(request));
    c2.send({ jsonrpc: "2.0", id: 771, result: { outcome: { outcome: "selected", optionId: "once" } } });
    c2.send({ jsonrpc: "2.0", method: "TEST_EMIT", params: { line: request } });
    const next = JSON.parse(await c2.waitFor((line) => line.includes('"_devin-web/request_identity"') && !line.includes(first.params.requestId)));
    expect(next.params.requestId).toMatch(/^req-[a-f0-9]{32}$/);
    expect(next.params.requestId).not.toBe(first.params.requestId);
    c2.close();
  });

  it("hello leads the first response on every connection, connId bumps", async () => {
    const { sockPath } = await startDaemon();
    let lastConnId = 0;
    for (let i = 0; i < 2; i++) {
      const c = rpcClient(sockPath);
      c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await c.waitFor((l) => l.includes('"id":1'));
      // the FIRST line on the wire is the hello (id-space epoch), before
      // any answer to the data that carried the adoption
      const first = JSON.parse(c.lines[0]);
      expect(first.method).toBe("_devin-web/hello");
      expect(first.params.connId).toBeGreaterThan(lastConnId);
      lastConnId = first.params.connId;
      expect(c.lines.findIndex((l) => l.includes('"id":1'))).toBeGreaterThan(0);
      c.close();
      await new Promise((r) => setTimeout(r, 60));
    }
  });

  it("D2: a null result on a watched request is forwarded, never crashes", async () => {
    const { daemon, sockPath } = await startDaemon();
    const c = rpcClient(sockPath);
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c.waitFor((l) => l.includes('"id":1'));
    // session/new whose real response is deferred; inject a legal {"result":null}
    c.send({ jsonrpc: "2.0", id: 7, method: "session/new", params: { _defer: true } });
    await new Promise((r) => setTimeout(r, 50));
    c.send({ jsonrpc: "2.0", method: "TEST_EMIT", params: { line: JSON.stringify({ jsonrpc: "2.0", id: 7, result: null }) } });
    const r = JSON.parse(await c.waitFor((l) => l.includes('"id":7')));
    expect(r.result).toBeNull();
    // daemon still alive and no phantom session tracked
    c.send({ jsonrpc: "2.0", id: 8, method: "_devin-web/shim_info", params: {} });
    const info = JSON.parse(await c.waitFor((l) => l.includes('"id":8')));
    expect(info.result.acpAlive).toBe(true);
    expect([...daemon.loadedSessions.keys()]).toHaveLength(0);
    c.close();
  });

  it("D3: session/new records its cwd for adoption", async () => {
    const { sockPath } = await startDaemon();
    const c = rpcClient(sockPath);
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c.waitFor((l) => l.includes('"id":1'));
    c.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/work/repo" } });
    await c.waitFor((l) => l.includes('"id":2'));
    c.send({ jsonrpc: "2.0", id: 3, method: "_devin-web/shim_state", params: {} });
    const st = JSON.parse(await c.waitFor((l) => l.includes('"id":3')));
    expect(st.result.sessions[0]).toMatchObject({ sessionId: "s-fake-1", cwd: "/work/repo" });
    c.close();
  });

  it("D7: grace-expired requests release their buffered bytes", async () => {
    const { daemon, sockPath } = await startDaemon({ requestGraceMs: 200 });
    const c1 = rpcClient(sockPath);
    c1.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c1.waitFor((l) => l.includes('"id":1'));
    c1.close();
    await new Promise((r) => setTimeout(r, 100));
    const perm = JSON.stringify({ jsonrpc: "2.0", id: 55, method: "session/request_permission", params: { sessionId: "s1", toolCall: { id: "t1" } } });
    const c2 = rpcClient(sockPath);
    c2.send({ jsonrpc: "2.0", method: "TEST_EMIT", params: { line: perm } });
    await new Promise((r) => setTimeout(r, 100));
    expect(daemon._test.undeliveredBytes).toBeGreaterThan(0);
    // grace expires → daemon answers the agent and the bytes must be released.
    // (the fake's TEST_OBSERVED echo stays buffered as a notif — that's fine;
    // the invariant is bytes === sum of remaining items, previously it leaked)
    await new Promise((r) => setTimeout(r, 400));
    expect(daemon._test.undelivered.filter((u: { kind: string }) => u.kind === "request")).toHaveLength(0);
    const sum = daemon._test.undelivered.reduce((a: number, u: { bytes: number }) => a + u.bytes, 0);
    expect(daemon._test.undeliveredBytes).toBe(sum);
    c2.close();
  });

  it("D1: the socket is born 0600 (no listen-then-chmod window)", async () => {
    const { sockPath } = await startDaemon();
    const { statSync } = await import("node:fs");
    expect(statSync(sockPath).mode & 0o777).toBe(0o600);
  });

  it("C2: per-session cap evicts only that session's notifications", async () => {
    // small per-session cap; quiet session's early notif must survive the
    // busy session's flood (previously the global-oldest pick ate it)
    const { daemon, sockPath } = await startDaemon({ sessionBufferBytes: 800, globalBufferBytes: 64 * 1024 });
    const c1 = rpcClient(sockPath);
    c1.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c1.waitFor((l) => l.includes('"id":1'));
    c1.close();
    await new Promise((r) => setTimeout(r, 100));

    const c2 = rpcClient(sockPath);
    const notif = (sid: string, text: string) =>
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { kind: "text", text } } });
    // quiet session writes FIRST, then the busy session floods past its cap
    c2.send({ jsonrpc: "2.0", method: "TEST_EMIT", params: { line: notif("s-quiet", "keep-me") } });
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 20; i++) {
      c2.send({ jsonrpc: "2.0", method: "TEST_EMIT", params: { line: notif("s-busy", `flood-${i}-${"x".repeat(200)}`) } });
    }
    await new Promise((r) => setTimeout(r, 400));

    const buffered = daemon._test.undelivered.filter((u: { kind: string }) => u.kind === "notif");
    const quiet = buffered.filter((u: { sessionId: string }) => u.sessionId === "s-quiet");
    const busy = buffered.filter((u: { sessionId: string }) => u.sessionId === "s-busy");
    expect(quiet).toHaveLength(1); // quiet session's data survived the flood
    expect(busy.length).toBeLessThan(20); // busy session ate its own cap
    c2.close();
  });

  it("A3/A7: spawns acp with the state dir as cwd (neutral landing zone)", async () => {
    const { daemon, dir } = await startDaemon();
    const pid = daemon.info().acpPid!;
    // /proc is Linux-only — the dev environment (and every real deploy) is Linux
    const { readlinkSync } = await import("node:fs");
    expect(readlinkSync(`/proc/${pid}/cwd`)).toBe(dir);
  });



  it("A3: writes acpd-status.json the web can read without touching the socket", async () => {
    const { daemon, dir } = await startDaemon();
    const { readFileSync } = await import("node:fs");
    // spawned acp recorded at spawn time
    await vi.waitFor(() => {
      const st = JSON.parse(readFileSync(join(dir, "acpd-status.json"), "utf8"));
      expect(st.acpPid).toBe(daemon.info().acpPid);
      expect(st.degraded).toBeNull();
    });
    // client adoption updates the file
    const c = rpcClient(join(dir, "acp.sock"));
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c.waitFor((l) => l.includes('"id":1'));
    await vi.waitFor(() => {
      const st = JSON.parse(readFileSync(join(dir, "acpd-status.json"), "utf8"));
      expect(st.connectedClient).toBeTruthy();
    });
    c.close();
  });

  it("acpd-status.json converges to the latest client through rapid displace", async () => {
    const { sockPath, dir } = await startDaemon();
    const { readFileSync } = await import("node:fs");
    const status = () => JSON.parse(readFileSync(join(dir, "acpd-status.json"), "utf8"));
    let cur = rpcClient(sockPath);
    cur.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await cur.waitFor((l) => l.includes('"id":1'));
    // each iteration displaces: dropClient writes connectedClient:null and
    // the adopt writes the new addr back-to-back — serialized, the LAST call
    // must win or daemonHasClient() reads a live attach as "no client"
    for (let i = 0; i < 5; i++) {
      const next = rpcClient(sockPath);
      next.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await next.waitFor((l) => l.includes('"id":1'));
      cur = next;
    }
    await vi.waitFor(() => expect(status().connectedClient).toBeTruthy());
    // a stale write would land in this window and flip it back to null
    await new Promise((r) => setTimeout(r, 50));
    expect(status().connectedClient).toBeTruthy();
    cur.close();
  });

  it("stop() completes even with a mute probe socket still connected", async () => {
    const { daemon, sockPath } = await startDaemon();
    // a probe/scanner that connects but never sends data stays unadopted —
    // server.close() waits on every open socket, so stop() must destroy
    // these too or shutdown hangs forever
    const probe = connect(sockPath);
    await new Promise((r) => probe.once("connect", r));
    const t0 = Date.now();
    await daemon.stop();
    expect(Date.now() - t0).toBeLessThan(8000);
    probe.destroy();
    daemons = daemons.filter((d) => d !== daemon);
  });
});

describe("N2: prompt error responses also clear busy", () => {
  it("an error response to session/prompt releases busy + synthesizes turn_end", async () => {
    const { sockPath } = await startDaemon();
    const c = rpcClient(sockPath);
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c.waitFor((l) => l.includes('"id":1'));
    c.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
    await c.waitFor((l) => l.includes('"id":2'));
    c.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s-fake-1", _defer: true, prompt: [] } });
    await new Promise((r) => setTimeout(r, 80));
    // the agent answers the prompt with an ERROR, not a result — the turn is
    // over either way, so busy must clear and the synthesized turn_end flow
    c.send({ jsonrpc: "2.0", method: "TEST_EMIT", params: {
      line: JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32000, message: "boom" } }) } });
    const te = JSON.parse(await c.waitFor((l) => l.includes("_devin-web/turn_end")));
    expect(te.params.sessionId).toBe("s-fake-1");
    c.send({ jsonrpc: "2.0", id: 4, method: "_devin-web/shim_state", params: {} });
    const st = JSON.parse(await c.waitFor((l) => l.includes('"id":4')));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(st.result.sessions.find((s: any) => s.sessionId === "s-fake-1").busy).toBe(false);
    c.close();
  });
});

describe("forked session tracking", () => {
  it("keeps the child busy across a client reconnect and clears it at turn end", async () => {
    const { daemon, sockPath } = await startDaemon();
    const c = rpcClient(sockPath);
    c.send({ id: 1, method: "initialize", params: {} });
    await c.waitFor((l) => JSON.parse(l).id === 1);
    c.send({ id: 2, method: "session/load", params: { sessionId: "parent", cwd: "/parent" } });
    await c.waitFor((l) => JSON.parse(l).id === 2);
    c.send({ id: 3, method: "session/fork", params: { sessionId: "parent", cwd: "/child" } });
    await c.waitFor((l) => JSON.parse(l).id === 3);
    c.send({ id: 4, method: "session/prompt", params: { sessionId: "s-fake-fork", _defer: true } });
    c.send({ id: 5, method: "_devin-web/shim_state", params: {} });
    const state = JSON.parse(await c.waitFor((l) => JSON.parse(l).id === 5));
    expect(state.result.sessions).toContainEqual(expect.objectContaining({ sessionId: "s-fake-fork", cwd: "/child", busy: true }));
    expect(daemon.sessionsState()).toContainEqual(expect.objectContaining({ sessionId: "parent", busy: false }));
    c.close();
    const next = rpcClient(sockPath);
    next.send({ id: 7, method: "initialize", params: {} });
    await next.waitFor((l) => JSON.parse(l).id === 7);
    next.send({ id: 8, method: "_devin-web/shim_state", params: {} });
    const reconnected = JSON.parse(await next.waitFor((l) => JSON.parse(l).id === 8));
    expect(reconnected.result.sessions).toContainEqual(expect.objectContaining({ sessionId: "s-fake-fork", busy: true }));
    next.send({ method: "TEST_FLUSH" });
    await next.waitFor((l) => JSON.parse(l).method === "_devin-web/turn_end");
    expect(daemon.sessionsState()).toContainEqual(expect.objectContaining({ sessionId: "s-fake-fork", busy: false }));
    next.close();
  });
});

describe("daemon UTF-8 transport", () => {
  it("preserves split characters in both client requests and agent notifications", async () => {
    const { daemon, sockPath } = await startDaemon();
    const c = rpcClient(sockPath);
    c.sock.setEncoding("utf8");
    c.send({ id: 1, method: "initialize", params: {} });
    await c.waitFor((l) => JSON.parse(l).id === 1);
    const wire = Buffer.from(enc({ id: 2, method: "session/load", params: { sessionId: "utf8", cwd: "/한글🙂" } }));
    const cut = wire.indexOf(Buffer.from("한")) + 1;
    c.sock.write(wire.subarray(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 20));
    c.sock.write(wire.subarray(cut));
    await c.waitFor((l) => JSON.parse(l).id === 2);
    expect(daemon.loadedSessions.get("utf8").cwd).toBe("/한글🙂");
    const line = JSON.stringify({ method: "utf8_notification", params: { text: "한글🙂" } });
    c.send({ method: "TEST_EMIT", params: { line, splitAt: Buffer.from(line).indexOf(Buffer.from("한")) + 1 } });
    const out = JSON.parse(await c.waitFor((l) => JSON.parse(l).method === "utf8_notification"));
    expect(out.params.text).toBe("한글🙂");
    c.close();
  });
});

/** Drive an AGENT→client fs request while no web client is ready, and
 *  return the daemon's own answer: fake-acp echoes every response it
 *  receives as TEST_OBSERVED, buffered until the next client initializes.
 *  `leaked` = the request itself was replayed to the web (it must not be). */
async function agentFsWhileDetached(sockPath: string, req: { id: number; method: string; params: object }) {
  const emitter = rpcClient(sockPath); // speaks, never initializes → not ready
  emitter.send({ jsonrpc: "2.0", method: "TEST_EMIT", params: { line: JSON.stringify({ jsonrpc: "2.0", ...req }) } });
  await new Promise((r) => setTimeout(r, 300));
  const reader = rpcClient(sockPath);
  reader.send({ jsonrpc: "2.0", id: 9001, method: "initialize", params: {} });
  const obs = JSON.parse(await reader.waitFor((l) => l.includes("TEST_OBSERVED") && l.includes(`"id":${req.id}`)));
  await new Promise((r) => setTimeout(r, 100));
  const leaked = reader.lines.some((l) => l.includes(`"method":"${req.method}"`));
  emitter.close();
  reader.close();
  return { res: obs.params.original as { result?: { content?: string }; error?: { message: string } }, leaked };
}

/** A ready client registers a session (fake id s-fake-1) and leaves. */
async function sessionThenDetach(sockPath: string, cwd: string) {
  const c = rpcClient(sockPath);
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await c.waitFor((l) => l.includes('"id":1'));
  c.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd } });
  await c.waitFor((l) => l.includes('"id":2'));
  c.close();
  await new Promise((r) => setTimeout(r, 100));
}

  it("serves the agent's fs/read_text_file itself while no web client is ready (R12 C3)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpd-fs-"));
    dirs.push(dir);
    const { sockPath } = await startDaemon({ fsRoots: [dir], dir });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "f.txt"), "line1\nline2\nline3\n");
    await sessionThenDetach(sockPath, dir);
    const ok = await agentFsWhileDetached(sockPath, { id: 77, method: "fs/read_text_file", params: { path: join(dir, "f.txt"), line: 2, limit: 1 } });
    expect(ok.res.result?.content).toBe("line2");
    expect(ok.leaked).toBe(false);
    const denied = await agentFsWhileDetached(sockPath, { id: 78, method: "fs/read_text_file", params: { path: "/etc/hostname" } });
    expect(denied.res.error?.message).toContain("DEVIN_WEB_FS_ROOTS");
  });

  it("caps a detached fs/read_text_file at 1MB with an explicit truncation marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpd-fs-"));
    dirs.push(dir);
    const { sockPath } = await startDaemon({ fsRoots: [dir], dir });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "big.txt"), "z".repeat(2 * 1024 * 1024));
    await sessionThenDetach(sockPath, dir);
    const r = await agentFsWhileDetached(sockPath, { id: 79, method: "fs/read_text_file", params: { path: join(dir, "big.txt") } });
    expect(r.res.result!.content!.length).toBeLessThan(1.1 * 1024 * 1024);
    expect(r.res.result!.content).toContain("[truncated:");
  });

  it("A7: detached relative fs paths resolve against the SESSION cwd", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "acpd-sess-"));
    dirs.push(sessionDir);
    const { sockPath } = await startDaemon();
    await sessionThenDetach(sockPath, sessionDir);
    const w = await agentFsWhileDetached(sockPath, { id: 80, method: "fs/write_text_file", params: { sessionId: "s-fake-1", path: "shot.txt", content: "ok" } });
    expect(w.res.result).toBeDefined();
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(sessionDir, "shot.txt"))).toBe(true);
    const r = await agentFsWhileDetached(sockPath, { id: 81, method: "fs/read_text_file", params: { sessionId: "s-fake-1", path: "shot.txt" } });
    expect(r.res.result?.content).toBe("ok");
  });

  it("A7: detached fs requests outside roots AND the session cwd are refused", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "acpd-sess-"));
    const allowedDir = await mkdtemp(join(tmpdir(), "acpd-allowed-"));
    dirs.push(sessionDir, allowedDir);
    const { sockPath } = await startDaemon({ fsRoots: [allowedDir] });
    await sessionThenDetach(sockPath, sessionDir);
    const ok = await agentFsWhileDetached(sockPath, { id: 82, method: "fs/write_text_file", params: { sessionId: "s-fake-1", path: "a.txt", content: "x" } });
    expect(ok.res.result).toBeDefined();
    const denied = await agentFsWhileDetached(sockPath, { id: 83, method: "fs/read_text_file", params: { sessionId: "s-fake-1", path: "../../etc/hostname" } });
    expect(denied.res.error?.message).toContain("DEVIN_WEB_FS_ROOTS");
  });

  it("forwards the agent's fs request to a READY web client unchanged (R12 C3)", async () => {
    const { sockPath } = await startDaemon();
    const c = rpcClient(sockPath);
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await c.waitFor((l) => l.includes('"id":1'));
    const req = JSON.stringify({ jsonrpc: "2.0", id: 84, method: "fs/read_text_file", params: { path: "/tmp/x" } });
    c.send({ jsonrpc: "2.0", method: "TEST_EMIT", params: { line: req } });
    const fwd = await c.waitFor((l) => l.includes('"method":"fs/read_text_file"') && l.includes('"id":84'));
    expect(JSON.parse(fwd).params.path).toBe("/tmp/x");
    c.close();
  });

it("never delivers a detached fs result to a replacement ACP generation (R12 C3)", async () => {
  const fsRead = await import("../lib/acp/fsRead.mjs");
  let finishRead!: (text: string) => void;
  const pending = new Promise<string>((resolve) => { finishRead = resolve; });
  const read = vi.spyOn(fsRead, "readTextFile").mockImplementationOnce(() => pending);
  const { daemon, sockPath, dir } = await startDaemon({ respawnBackoffMs: [10] });
  const a = rpcClient(sockPath);
  let b: ReturnType<typeof rpcClient> | undefined;
  try {
    a.send({ jsonrpc: "2.0", method: "TEST_EMIT", params: {
      line: JSON.stringify({ jsonrpc: "2.0", id: 77, method: "fs/read_text_file", params: { path: join(dir, "slow.txt") } }),
    } });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const originalPid = daemon.info().acpPid!;
    process.kill(originalPid, "SIGKILL");
    await vi.waitFor(() => {
      expect(daemon.info().acpPid).toBeTruthy();
      expect(daemon.info().acpPid).not.toBe(originalPid);
    });
    b = rpcClient(sockPath);
    b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await b.waitFor((l) => l.includes('"id":1'));
    finishRead("OLD_GENERATION_FILE");
    await new Promise<void>((resolve) => setImmediate(resolve));
    // A response echoed by the new fake agent is a wire-order barrier:
    // if the old fs reply leaked, its echo precedes this echo.
    b.send({ jsonrpc: "2.0", id: 9002, result: { barrier: true } });
    await b.waitFor((l) => l.includes("TEST_OBSERVED") && l.includes('"id":9002'));
    expect(b.lines.some((l) => l.includes("TEST_OBSERVED") && l.includes('"id":77'))).toBe(false);
  } finally {
    finishRead("cleanup");
    read.mockRestore();
    a.close();
    b?.close();
  }
});
