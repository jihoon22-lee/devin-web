import { describe, expect, it, afterEach } from "vitest";
import { createServer, Server, Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHost } from "../lib/acp/host.mjs";
import { RemoteTerminalPool } from "../lib/acp/terminal-remote";

let servers: Server[] = [];
let dirs: string[] = [];
let pools: RemoteTerminalPool[] = [];
let serverSocks: Socket[] = [];
let realHosts: ReturnType<typeof createHost>[] = [];

afterEach(async () => {
  for (const p of pools) p.disconnect();
  pools = [];
  for (const host of realHosts) await host.stop();
  realHosts = [];
  for (const s of serverSocks) s.destroy();
  serverSocks = [];
  for (const s of servers) await new Promise((r) => s.close(r));
  servers = [];
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

function makePool(sockPath: string, timeout = 200) {
  const p = new RemoteTerminalPool(sockPath, timeout);
  pools.push(p);
  return p;
}

async function makeSock() {
  const dir = await mkdtemp(join(tmpdir(), "remote-test-"));
  dirs.push(dir);
  return join(dir, "host.sock");
}

/** Server that accepts sockets but never speaks — a hung daemon. */
async function deadServer(sockPath: string) {
  const s = createServer((sock) => {
    serverSocks.push(sock);
  });
  await new Promise<void>((r) => s.listen(sockPath, () => r()));
  servers.push(s);
  return s;
}

/** Minimal speaking host: answers every request with `{ result: {} }`. */
async function echoServer(sockPath: string, opts?: { dropFirst?: boolean }) {
  let conns = 0;
  const sockets: Socket[] = [];
  const s = createServer((sock) => {
    conns++;
    sockets.push(sock);
    serverSocks.push(sock);
    const n = conns;
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id != null) {
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\n");
        }
      }
    });
    if (opts?.dropFirst && n === 1) setTimeout(() => sock.destroy(), 60);
  });
  await new Promise<void>((r) => s.listen(sockPath, () => r()));
  servers.push(s);
  return { server: s, conns: () => conns, sockets };
}

describe("RemoteTerminalPool rpc timeout", () => {
  it("rejects a hung rpc instead of pending forever", async () => {
    const sockPath = await makeSock();
    await deadServer(sockPath);
    const pool = makePool(sockPath, 200);
    const t0 = Date.now();
    await expect(pool.call("term/list")).rejects.toThrow("timed out");
    expect(Date.now() - t0).toBeLessThan(3000);
    // a follow-up call also fails fast — the timed-out entry was cleaned up
    await expect(pool.call("term/list")).rejects.toThrow("timed out");
  });
});

describe("RemoteTerminalPool reconnect loop", () => {
  it("reattaches automatically after the socket drops — no request needed", async () => {
    const sockPath = await makeSock();
    const host = await echoServer(sockPath, { dropFirst: true });
    const pool = makePool(sockPath, 200);
    await pool.call("term/list"); // first connection works, then gets dropped
    await new Promise((r) => setTimeout(r, 200)); // drop happened
    // nothing pending, no calls in flight — the loop must reconnect on its own
    await new Promise((r) => setTimeout(r, 1800)); // > reconnectDelay (1s)
    expect(host.conns()).toBeGreaterThanOrEqual(2);
    // and the new socket actually serves requests
    await expect(pool.call("term/list")).resolves.toEqual({ ok: true });
  }, 10000);
});

describe("host first-data adoption", () => {
  it.each([false, true])("warmup and automatic reconnect receive database pushes (terminal stream=%s)", async (withTerminal) => {
    const sockPath = await makeSock();
    const cliDir = dirname(sockPath);
    let handshakes = 0;
    const host = createHost({ sockPath, cliDir, sessionsProvider: () => { handshakes++; return []; } });
    realHosts.push(host);
    await host.start();
    const pool = makePool(sockPath);
    let changes = 0;
    pool.onDbChanged(() => { changes++; });
    pool.warmup(); // no manual RPC or terminal stream to make the socket speak
    await expect.poll(() => !!host._test.client, { timeout: 2000 }).toBe(true);
    expect(handshakes).toBe(1);
    await writeFile(join(cliDir, "sessions.db"), "first commit");
    await expect.poll(() => changes, { timeout: 2000 }).toBe(1);

    let terminalId: string | undefined;
    if (withTerminal) {
      terminalId = (await pool.create({ sessionId: "reconnect", command: "cat", cwd: cliDir }, () => {})).terminalId;
      await pool.attach(terminalId, () => {}, () => {});
      expect(host._test.client!.attached.has(terminalId)).toBe(true);
    }
    const firstSocket = host._test.client!.sock;
    firstSocket.destroy();
    // Only the automatic retry speaks now, including when there are no streams.
    await expect.poll(() => !!host._test.client && host._test.client.sock !== firstSocket, { timeout: 3500 }).toBe(true);
    expect(handshakes).toBe(2);
    if (terminalId) await expect.poll(() => host._test.client?.attached.has(terminalId)).toBe(true);
    await writeFile(join(cliDir, "sessions.db"), "second commit");
    await expect.poll(() => changes, { timeout: 2000 }).toBe(2);
  }, 10_000);
});

describe("remote host UTF-8 transport", () => {
  it("decodes split multibyte characters in RPC responses", async () => {
    const sockPath = await makeSock();
    const server = createServer((sock) => {
      serverSocks.push(sock);
      let buf = "";
      sock.on("data", (data) => {
        buf += data.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
          if (msg.method !== "utf8") {
            sock.write(JSON.stringify({ id: msg.id, result: {} }) + "\n");
            continue;
          }
          const wire = Buffer.from(JSON.stringify({ id: msg.id, result: { text: "한글🙂" } }) + "\n");
          const cut = wire.indexOf(Buffer.from("한")) + 1;
          sock.write(wire.subarray(0, cut));
          setTimeout(() => sock.write(wire.subarray(cut)), 20);
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    expect(await makePool(sockPath, 1000).call("utf8")).toEqual({ text: "한글🙂" });
  });
});

describe("host state and database subscriptions", () => {
  it("keeps sessions/state and database notifications without requesting event history", async () => {
    const path = await makeSock();
    const methods: string[] = [];
    const sessions = [{ sessionId: "busy", cwd: "/tmp", busy: true, loaded: true }];
    const server = createServer((socket) => {
      serverSocks.push(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const request = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          methods.push(request.method);
          socket.write(JSON.stringify({ jsonrpc: "2.0", method: "_host/db_changed", params: {} }) + "\n");
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessions } }) + "\n");
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const pool = makePool(path);
    let changes = 0;
    const unsub = pool.onDbChanged(() => { changes++; });
    await expect(pool.sessionsState()).resolves.toEqual(sessions);
    expect(changes).toBe(2);
    unsub();
    await expect(pool.sessionsState()).resolves.toEqual(sessions);
    expect(changes).toBe(2);
    expect(methods).toEqual(["sessions/state", "sessions/state", "sessions/state"]);
  });
});
