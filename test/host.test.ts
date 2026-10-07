import { describe, expect, it, afterEach } from "vitest";
import { connect } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../lib/acp/host.mjs";

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
  const waitFor = (pred: (l: string) => boolean, ms = 4000) => {
    const hit = lines.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout waiting for line")), ms);
      waiters.push({ pred, res: (l) => { clearTimeout(t); res(l); } });
    });
  };
  const rpc = async (method: string, params: object = {}) => {
    const id = Math.floor(Math.random() * 1e9);
    sock.write(enc({ jsonrpc: "2.0", id, method, params }));
    return JSON.parse(await waitFor((l) => l.includes(`"id":${id}`)));
  };
  return { sock, lines, send: (m: object) => sock.write(enc(m)), waitFor, rpc, close: () => sock.destroy() };
}

let hosts: { stop: () => Promise<void> }[] = [];
let dirs: string[] = [];

afterEach(async () => {
  for (const h of hosts) await h.stop();
  hosts = [];
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function startHost(opts: { slowClientCutoffBytes?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "host-test-"));
  dirs.push(dir);
  const sockPath = join(dir, "host.sock");
  const host = createHost({ sockPath, ...opts });
  await host.start();
  hosts.push(host);
  return { host, sockPath, dir };
}

describe("devin-web host (Phase 2-1 terminals)", () => {
  it("create → attach → live output → exit event", async () => {
    const { sockPath } = await startHost();
    const c = rpcClient(sockPath);
    // output delayed past the attach — early output lives in the snapshot
    const created = await c.rpc("term/create", { command: "sleep 0.2; printf 'HELLO\\n'; sleep 0.1", cwd: "/tmp" });
    const id = created.result.terminalId;
    const att = await c.rpc("term/attach", { id });
    expect(att.result).not.toBeNull();
    expect(att.result.offset).toBeGreaterThanOrEqual(0);
    // live output + exit event stream to the attached client
    const out = JSON.parse(await c.waitFor((l) => l.includes("_host/term_output") && l.includes("HELLO")));
    expect(out.params.data).toContain("HELLO");
    const ev = JSON.parse(await c.waitFor((l) => l.includes("_host/term_event")));
    expect(ev.params.type).toBe("exit");
    expect(ev.params.exitCode).toBe(0);
    c.close();
  });

  it("snapshot + get_output reflect retained output and exit status", async () => {
    const { sockPath } = await startHost();
    const c = rpcClient(sockPath);
    const created = await c.rpc("term/create", { command: "printf 'DONE\\n'; sleep 0.05", cwd: "/tmp" });
    const id = created.result.terminalId;
    await new Promise((r) => setTimeout(r, 500));
    const snap = await c.rpc("term/snapshot", { id });
    expect(snap.result.output).toContain("DONE");
    expect(snap.result.exited).toBe(true);
    const out = await c.rpc("term/get_output", { id });
    expect(out.result.exitStatus.exitCode).toBe(0);
    c.close();
  });

  it("wait_for_exit holds the request until the process exits", async () => {
    const { sockPath } = await startHost();
    const c = rpcClient(sockPath);
    const created = await c.rpc("term/create", { command: "sleep 0.3; printf 'bye'", cwd: "/tmp" });
    const id = created.result.terminalId;
    const t0 = Date.now();
    const r = await c.rpc("term/wait_for_exit", { id });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    expect(r.result.exitCode).toBe(0);
    c.close();
  });

  it("input reaches the pty and shows up in output", async () => {
    const { sockPath } = await startHost();
    const c = rpcClient(sockPath);
    const created = await c.rpc("term/create", { command: "cat", cwd: "/tmp" });
    const id = created.result.terminalId;
    await c.rpc("term/attach", { id });
    await c.rpc("term/input", { id, data: "ping\n" });
    const out = JSON.parse(await c.waitFor((l) => l.includes("_host/term_output") && l.includes("ping")));
    expect(out.params.data).toContain("ping");
    await c.rpc("term/kill", { id });
    c.close();
  });

  it("list shows live terminals and hides dismissed ones", async () => {
    const { sockPath } = await startHost();
    const c = rpcClient(sockPath);
    const a = await c.rpc("term/create", { command: "sleep 5", cwd: "/tmp", sessionId: "s1" });
    const b = await c.rpc("term/create", { command: "sleep 5", cwd: "/tmp", sessionId: "s2", user: true });
    const list = await c.rpc("term/list", {});
    const ids = list.result.terminals.map((t: { id: string }) => t.id);
    expect(ids).toContain(a.result.terminalId);
    expect(ids).toContain(b.result.terminalId);
    // sessionId filter
    const s1 = await c.rpc("term/list", { sessionId: "s1" });
    expect(s1.result.terminals.map((t: { id: string }) => t.id)).toEqual([a.result.terminalId]);
    // dismiss hides it (user shell → released+hidden)
    await c.rpc("term/dismiss", { id: b.result.terminalId });
    const after = await c.rpc("term/list", {});
    expect(after.result.terminals.map((t: { id: string }) => t.id)).not.toContain(b.result.terminalId);
    await c.rpc("term/kill", { id: a.result.terminalId });
    c.close();
  });

  it("term/keep pins a user shell and the list reports it", async () => {
    const { sockPath } = await startHost();
    const c = rpcClient(sockPath);
    const b = await c.rpc("term/create", { command: "sleep 5", cwd: "/tmp", sessionId: "k1", user: true });
    const id = b.result.terminalId;
    await c.rpc("term/keep", { id, keep: true });
    const list = await c.rpc("term/list", { sessionId: "k1" });
    expect(list.result.terminals[0]).toMatchObject({ id, keep: true, user: true });
    expect(typeof list.result.terminals[0].lastActivity).toBe("number");
    await c.rpc("term/keep", { id, keep: false });
    expect((await c.rpc("term/list", { sessionId: "k1" })).result.terminals[0].keep).toBe(false);
    await c.rpc("term/kill", { id });
    c.close();
  });

  it("unknown terminal ids error instead of hanging", async () => {
    const { sockPath } = await startHost();
    const c = rpcClient(sockPath);
    const r = await c.rpc("term/get_output", { id: "term-nope" });
    expect(r.error.message).toContain("unknown terminal");
    const w = await c.rpc("term/wait_for_exit", { id: "term-nope" });
    expect(w.error.message).toContain("unknown terminal");
    c.close();
  });

  it("a bare connect does NOT displace the live client; a speaker does", async () => {
    const { host, sockPath } = await startHost();
    const c1 = rpcClient(sockPath);
    await c1.rpc("term/list", {});
    const before = host._test.client;
    // silent probe — connect+destroy without speaking
    const probe = connect(sockPath);
    await new Promise((r) => probe.once("connect", r));
    probe.destroy();
    await new Promise((r) => setTimeout(r, 150));
    expect(host._test.client).toBe(before);
    // a second client that SPEAKS replaces — old one gets _host/replaced
    const c2 = rpcClient(sockPath);
    c2.send({ jsonrpc: "2.0", id: 9, method: "term/list", params: {} });
    const replaced = await c1.waitFor((l) => l.includes("_host/replaced"));
    expect(JSON.parse(replaced).method).toBe("_host/replaced");
    c1.close();
    c2.close();
  });

  it("release tombstones the terminal (output kept, exited flagged)", async () => {
    const { sockPath } = await startHost();
    const c = rpcClient(sockPath);
    const created = await c.rpc("term/create", { command: "printf 'keep\\n'; sleep 5", cwd: "/tmp" });
    const id = created.result.terminalId;
    await new Promise((r) => setTimeout(r, 250));
    await c.rpc("term/release", { id });
    const out = await c.rpc("term/get_output", { id });
    expect(out.result.output).toContain("keep");
    expect(out.result.exitStatus).not.toBeNull();
    c.close();
  });

  it("release pushes a released term_event to attached clients", async () => {
    const { sockPath } = await startHost();
    const c = rpcClient(sockPath);
    const created = await c.rpc("term/create", { command: "sleep 5", cwd: "/tmp" });
    const id = created.result.terminalId;
    await c.rpc("term/attach", { id });
    await c.rpc("term/release", { id });
    const ev = JSON.parse(
      await c.waitFor((l) => l.includes("_host/term_event") && l.includes("released")),
    );
    expect(ev.params.type).toBe("released");
    expect(ev.params.id).toBe(id);
    c.close();
  });

  it("destroys a slow consumer whose socket buffer exceeds the cutoff", async () => {
    const { host, sockPath } = await startHost({ slowClientCutoffBytes: 256 * 1024 });
    // raw socket that never reads → server-side writableLength grows
    const raw = connect(sockPath);
    await new Promise((r) => raw.once("connect", r));
    raw.write(enc({ jsonrpc: "2.0", id: 1, method: "term/create", params: { command: "yes abcdefghijklmnopqrstuvwxyz0123456789", cwd: "/tmp" } }));
    // adopt + create + attach all over the same socket without reading
    await new Promise((r) => setTimeout(r, 200));
    // read just enough to get the create response (hello/pushes interleave),
    // then jam the socket
    let buf = "";
    raw.resume();
    const id: string = await new Promise((res, rej) => {
      const onData = (d: Buffer) => {
        buf += d.toString();
        for (const line of buf.split("\n")) {
          if (!line.includes('"id":1')) continue;
          res(JSON.parse(line).result.terminalId);
        }
      };
      raw.on("data", onData);
      setTimeout(() => rej(new Error("no create response")), 3000);
    });
    raw.removeAllListeners("data");
    raw.pause();
    raw.write(enc({ jsonrpc: "2.0", id: 2, method: "term/attach", params: { id } }));
    // a paused socket defers its own 'close' event — assert on the server
    // side: the flooded pushes trip the cutoff and dropClient runs
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      if (!host._test.client) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(host._test.client).toBeNull();
    raw.destroy();
  }, 20000);
});

describe("devin-web host (session state and db watch)", () => {
  it("unknown ev/* methods answer -32601 and notifications are ignored (V4-2)", async () => {
    const { sockPath } = await startHost();
    const c = rpcClient(sockPath);
    c.send({ jsonrpc: "2.0", method: "ev/append", params: { sessionId: "s", ev: { seq: 1 } } });
    for (const method of ["ev/since", "ev/hello"]) {
      const r = await c.rpc(method, { sessionId: "s", after: 0 });
      expect(r.error.code).toBe(-32601);
    }
    const state = await c.rpc("sessions/state", {});
    expect(state.result.sessions).toEqual([]);
    expect(c.lines.map((line) => JSON.parse(line)).filter((msg) => msg.error)).toHaveLength(2);
    c.close();
  });

  it("sessions/state reports provider sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-test-"));
    dirs.push(dir);
    const sockPath = join(dir, "host.sock");
    const sessions = [{ sessionId: "s-live", cwd: "/tmp", busy: true, loaded: true }];
    const host = createHost({ sockPath, sessionsProvider: () => sessions });
    await host.start();
    hosts.push(host);
    const c = rpcClient(sockPath);
    const state = await c.rpc("sessions/state", {});
    expect(state.result.sessions).toEqual(sessions);
    c.close();
  });

  it("pushes _host/db_changed when sessions.db commits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-test-"));
    dirs.push(dir);
    const cliDir = join(dir, "cli");
    await mkdtemp(cliDir).catch(() => {});
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cliDir, { recursive: true });
    const sockPath = join(dir, "host.sock");
    const host = createHost({ sockPath, cliDir });
    await host.start();
    hosts.push(host);
    const c = rpcClient(sockPath);
    await c.rpc("term/list", {}); // adopt
    await writeFile(join(cliDir, "sessions.db"), "x");
    const line = await c.waitFor((l) => l.includes("_host/db_changed"), 3000);
    expect(JSON.parse(line).method).toBe("_host/db_changed");
    c.close();
  });
});

describe("host UTF-8 transport", () => {
  it("preserves a terminal request whose Korean text is split inside a character", async () => {
    const { sockPath } = await startHost();
    const c = rpcClient(sockPath);
    const command = "printf '한글🙂'";
    const id = 987654;
    const wire = Buffer.from(enc({ jsonrpc: "2.0", id, method: "term/create", params: { command, cwd: "/tmp" } }));
    const cut = wire.indexOf(Buffer.from("한")) + 1;
    c.sock.write(wire.subarray(0, cut));
    await c.waitFor((l) => l.includes('"_host/hello"'));
    c.sock.write(wire.subarray(cut));
    const created = JSON.parse(await c.waitFor((l) => l.includes(`"id":${id}`)));
    const listed = await c.rpc("term/list", {});
    expect(listed.result.terminals.find((t: { id: string }) => t.id === created.result.terminalId).label).toBe(command);
    c.close();
  });
});

describe("wait_for_exit ownership (R12 C1)", () => {
  it("a late reply never reaches a replacement client", async () => {
    const { sockPath } = await startHost();
    const a = rpcClient(sockPath);
    const created = await a.rpc("term/create", { command: "sleep 0.4", cwd: "/tmp" });
    const id = created.result.terminalId;
    a.send({ jsonrpc: "2.0", id: 4242, method: "term/wait_for_exit", params: { id } });
    await new Promise((r) => setTimeout(r, 50));
    const b = rpcClient(sockPath);
    await b.rpc("term/list", {}); // b speaks → adopted, a replaced
    await new Promise((r) => setTimeout(r, 700)); // the pty exits meanwhile
    expect(b.lines.some((l) => l.includes('"id":4242'))).toBe(false);
    a.close();
    b.close();
  });
});
