import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bin/devin-web-idle-restart.mjs reads DEVIN_WEB_ACP_SOCK at module load —
// set it per test BEFORE the dynamic import, then reset modules so each
// import re-reads the env.
const enc = (m: object) => JSON.stringify(m) + "\n";

let dirs: string[] = [];
let servers: Server[] = [];
let socks: Socket[] = [];

function makeSock() {
  const dir = mkdtempSync(join(tmpdir(), "dw-idle-"));
  dirs.push(dir);
  return join(dir, "acp.sock");
}

async function importShim(sockPath: string) {
  process.env.DEVIN_WEB_ACP_SOCK = sockPath;
  vi.resetModules(); // SOCK is a module-level const — a cached import would keep the previous path
  const mod = await import("../bin/devin-web-idle-restart.mjs");
  return mod.shimBusy as () => Promise<number | null>;
}

async function serve(sockPath: string, onData: (sock: Socket, line: string) => void) {
  const srv = createServer((sock) => {
    socks.push(sock);
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onData(sock, line);
      }
    });
    sock.on("error", () => {});
  });
  servers.push(srv);
  await new Promise<void>((res, rej) => {
    srv.once("error", rej);
    srv.listen(sockPath, res);
  });
  return srv;
}

afterEach(async () => {
  for (const s of socks) s.destroy();
  socks = [];
  for (const s of servers) await new Promise((r) => s.close(r));
  servers = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("idle-restart shimBusy", () => {
  it("skips the daemon's hello notification and reads the real response", async () => {
    const sockPath = makeSock();
    // real daemon order: `_devin-web/hello` lands on the wire BEFORE the
    // shim_state response — the old code parsed the first line and always
    // returned null, leaving the web-down fallback permanently undecided.
    await serve(sockPath, (sock) => {
      sock.write(enc({ jsonrpc: "2.0", method: "_devin-web/hello", params: { connId: 7 } }));
      sock.write(enc({
        jsonrpc: "2.0",
        id: 1,
        result: { sessions: [{ sessionId: "a", busy: true }, { sessionId: "b", busy: false }] },
      }));
    });
    const shimBusy = await importShim(sockPath);
    expect(await shimBusy()).toBe(1);
  });

  it("returns null when the daemon never answers (timeout)", async () => {
    const sockPath = makeSock();
    await serve(sockPath, (sock) => {
      sock.write(enc({ jsonrpc: "2.0", method: "_devin-web/hello", params: { connId: 1 } }));
      // no response — simulates a hung daemon
    });
    const shimBusy = await importShim(sockPath);
    expect(await shimBusy()).toBeNull();
  }, 8000);

  it("returns null on a refused connect", async () => {
    const sockPath = makeSock(); // no server listening
    const shimBusy = await importShim(sockPath);
    expect(await shimBusy()).toBeNull();
  });
});

describe("idle-restart daemonHasClient (M1)", () => {
  it("reads connectedClient from acpd-status.json; unknown counts as attached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dw-idle-st-"));
    dirs.push(dir);
    vi.resetModules();
    const { daemonHasClient } = await import("../bin/devin-web-idle-restart.mjs");
    const p = join(dir, "acpd-status.json");

    writeFileSync(p, JSON.stringify({ connectedClient: "local:1726740000000" }));
    expect(daemonHasClient(p)).toBe(true);

    writeFileSync(p, JSON.stringify({ connectedClient: null }));
    expect(daemonHasClient(p)).toBe(false);

    // missing/corrupt → assume a client is attached: never probe blind
    expect(daemonHasClient(join(dir, "missing.json"))).toBe(true);
  });

  it("never probes the socket while acpd-status shows a client attached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dw-idle-gate-"));
    dirs.push(dir);
    const sockPath = join(dir, "acp.sock");
    writeFileSync(join(dir, "acpd-status.json"), JSON.stringify({ connectedClient: "local:1" }));
    let conns = 0;
    const srv = createServer(() => conns++);
    servers.push(srv);
    await new Promise<void>((res, rej) => {
      srv.once("error", rej);
      srv.listen(sockPath, res);
    });
    // web "down" — HTTP keeps failing, so after the fallback threshold the
    // daemonHasClient gate must keep shimBusy holstered entirely
    process.env.DEVIN_WEB_ACP_SOCK = sockPath;
    process.env.DEVIN_WEB_PORT = "1"; // refused
    vi.resetModules();
    const mod = await import("../bin/devin-web-idle-restart.mjs");
    expect(await mod.runningCount()).toBeNull();
    expect(await mod.runningCount()).toBeNull();
    expect(conns).toBe(0); // the socket was never touched
    delete process.env.DEVIN_WEB_PORT;
  });

  it("does probe when the status file shows no client attached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dw-idle-open-"));
    dirs.push(dir);
    const sockPath = join(dir, "acp.sock");
    writeFileSync(join(dir, "acpd-status.json"), JSON.stringify({ connectedClient: null }));
    await serve(sockPath, (sock) => {
      sock.write(enc({ jsonrpc: "2.0", id: 1, result: { sessions: [{ sessionId: "a", busy: false }] } }));
    });
    process.env.DEVIN_WEB_ACP_SOCK = sockPath;
    process.env.DEVIN_WEB_PORT = "1";
    vi.resetModules();
    const mod = await import("../bin/devin-web-idle-restart.mjs");
    expect(await mod.runningCount()).toBeNull(); // first HTTP failure — no probe yet
    expect(await mod.runningCount()).toBe(0); // fallback armed → shimBusy ran
    delete process.env.DEVIN_WEB_PORT;
  });
});
