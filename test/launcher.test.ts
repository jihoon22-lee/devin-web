import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { launchOptions, validateNode } from "../bin/runtime.mjs";

const exec = promisify(execFile);
const roots: string[] = [];
const ownedProcesses: number[] = [];
afterEach(async () => {
  for (const pid of ownedProcesses.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch {} }
  for (const root of roots.splice(0)) {
    for (const file of ["pid", "web-watch.pid", "acpd.pid", "custom-acpd.pid"]) {
      try { process.kill(-Number(readFileSync(join(root, "state", file), "utf8")), "SIGKILL"); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(build = true) {
  const root = mkdtempSync(join(tmpdir(), "dw-launcher-")); roots.push(root);
  mkdirSync(join(root, "bin")); mkdirSync(join(root, "lib"));
  for (const file of ["devin-web.mjs", "runtime.mjs", "devin-web-ctl", "devin-web-watch.mjs"]) {
    if (existsSync(join(process.cwd(), "bin", file))) copyFileSync(join(process.cwd(), "bin", file), join(root, "bin", file));
  }
  copyFileSync(join(process.cwd(), "lib/paths.mjs"), join(root, "lib/paths.mjs"));
  mkdirSync(join(root, "node_modules/next/dist/bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "1" } }));
  writeFileSync(join(root, "node_modules/next/package.json"), JSON.stringify({ main: "dist/bin/next" }));
  writeFileSync(join(root, "node_modules/next/dist/bin/next"), 'console.log("CAPTURE " + JSON.stringify({args:process.argv.slice(2),env:process.env}));');
  if (build) { mkdirSync(join(root, ".next")); writeFileSync(join(root, ".next/BUILD_ID"), "fixture"); }
  mkdirSync(join(root, "tools"));
  // The orphan check must only target the selected CLI, never another install.
  writeFileSync(join(root, "tools/pgrep"), '#!/bin/sh\nprintf "%s\n" "$*" > "$DEVIN_WEB_STATE_DIR/pgrep-args"\nexit 1\n');
  chmodSync(join(root, "tools/pgrep"), 0o755);
  return root;
}
function env(root: string, extra: Record<string, string | undefined> = {}) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith("DEVIN_") || ["PORT", "HOST", "NODE_OPTIONS"].includes(key)) delete clean[key];
  return { ...clean, DEVIN_WEB_STATE_DIR: join(root, "state"), DEVIN_WEB_NO_OPEN: "1", PATH: `${join(root, "tools")}:${clean.PATH}`, ...extra };
}
async function run(root: string, args: string[] = [], extra: Record<string, string | undefined> = {}) {
  if (!args.some((a) => a === "--port" || a === "-p" || a.startsWith("--port=")) && extra.PORT === undefined && extra.DEVIN_WEB_PORT === undefined) {
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
    extra = { ...extra, PORT: String((socket.address() as {port:number}).port) };
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
  try { return { ...(await exec(process.execPath, [join(root, "bin/devin-web.mjs"), ...args], { env: env(root, extra), timeout: 5000 })), code: 0 }; }
  catch (e) { const err = e as { stdout: string; stderr: string; code: number }; return err; }
}
const capture = (stdout: string) => JSON.parse(stdout.split("\n").find((line) => line.startsWith("CAPTURE "))!.slice(8));

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return String(port);
}
function serviceFixture() {
  const root = fixture();
  writeFileSync(join(root, "node_modules/next/dist/bin/next"), `
    const fs = require("node:fs"), http = require("node:http");
    fs.writeFileSync(process.env.DEVIN_WEB_STATE_DIR + "/child-env.json", JSON.stringify(process.env));
    if (process.env.FAIL_NEXT) process.exit(1);
    http.createServer((req, res) => res.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
  `);
  writeFileSync(join(root, "bin/devin-acpd.mjs"), `
    import { createServer } from "node:net";
    import { writeFileSync, rmSync } from "node:fs";
    const pidfile = process.env.DEVIN_WEB_ACPD_PIDFILE;
    const socket = process.env.DEVIN_WEB_ACP_SOCK;
    createServer().listen(socket, () => {
      writeFileSync(pidfile, String(process.pid));
      writeFileSync(process.env.DEVIN_WEB_STATE_DIR + "/created-acpd", String(process.pid));
    });
    process.on("SIGTERM", () => { rmSync(pidfile, {force:true}); rmSync(socket, {force:true}); process.exit(0); });
  `);
  return root;
}
async function ctl(root: string, args: string[], extra: Record<string, string | undefined>) {
  return exec("bash", [join(root, "bin/devin-web-ctl"), ...args], { env: env(root, extra), timeout: 10000 }).then(
    (result) => ({ ...result, code: 0 }), (error) => error as { stdout: string; stderr: string; code: number },
  );
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

describe("public launcher boundaries", () => {
  it("defaults to exactly port 7100 without probing another service", () => {
    expect(launchOptions([], {}).port).toBe(7100);
  });
  it.each(["22.13.0", "24.17.9", "25.0.0", "24.18.0-rc.1"])("rejects unsupported Node %s", (version) => {
    expect(() => validateNode(version)).toThrow(/Node.js/);
  });
  it("accepts the supported Node range", () => {
    expect(() => validateNode("24.18.0")).not.toThrow(); expect(() => validateNode("24.20.0")).not.toThrow();
  });
  it("rejects missing production builds before writing pidfiles or starting Next", async () => {
    const root = fixture(false); const result = await run(root);
    expect(result.code).not.toBe(0); expect(result.stderr).toMatch(/pnpm build/);
    expect(result.stdout).not.toContain("CAPTURE"); expect(existsSync(join(root, "state"))).toBe(false);
  });
  it("uses only explicit --dev to bypass a missing build", async () => {
    const result = await run(fixture(false), ["--dev"]);
    expect(result.code).toBe(0); expect(capture(result.stdout).args[0]).toBe("dev");
  });
  it("requires the selected custom dist build, even when .next exists", async () => {
    const root = fixture(); const result = await run(root, [], { DEVIN_WEB_DIST_DIR: "out" });
    expect(result.code).not.toBe(0); expect(result.stderr).toContain("out");
    mkdirSync(join(root, "out")); writeFileSync(join(root, "out/BUILD_ID"), "custom");
    const success = await run(root, [], { DEVIN_WEB_DIST_DIR: "out" });
    expect(success.code).toBe(0); expect(capture(success.stdout).args[0]).toBe("start");
  });
  it.each([
    [[], { PORT: "17101" }, "17101"],
    [[], { PORT: "17101", DEVIN_WEB_PORT: "17102" }, "17102"],
    [["--port", "17103"], { PORT: "17101", DEVIN_WEB_PORT: "17102" }, "17103"],
    [["--port=17104"], {}, "17104"], [["-p", "17105"], {}, "17105"],
  ] as [string[], Record<string, string | undefined>, string][])("resolves port %j %j", async (args, extra, port) => {
    const result = await run(fixture(), args, extra); expect(result.code).toBe(0);
    expect(capture(result.stdout).args).toEqual(["start", "-H", "127.0.0.1", "-p", port]);
    expect(capture(result.stdout).env.DEVIN_WEB_PORT).toBe(port);
  });
  it.each(["0", "-1", "65536", "1.5", "abc", "", " 7100"])("rejects invalid port %j before pidfile creation", async (port) => {
    const root = fixture(); const result = await run(root, ["--port", port]);
    expect(result.code).not.toBe(0); expect(result.stderr).toMatch(/port/i); expect(existsSync(join(root, "state"))).toBe(false);
  });
  it("ignores ambient HOST and strips inherited sockets in explicit in-process mode", async () => {
    const result = await run(fixture(), [], { HOST: "0.0.0.0", DEVIN_WEB_ACPD: "0", DEVIN_WEB_ACP_SOCK: "/do-not-touch", DEVIN_WEB_HOST_SOCK: "/do-not-touch-host" });
    expect(result.code).toBe(0); const got = capture(result.stdout);
    expect(got.args[2]).toBe("127.0.0.1"); expect(got.env.DEVIN_WEB_ACP_SOCK).toBeUndefined(); expect(got.env.DEVIN_WEB_HOST_SOCK).toBeUndefined();
  });
  it("accepts explicit nonloopback host", async () => {
    const result = await run(fixture(), ["--host", "0.0.0.0"]); expect(result.code).toBe(0); expect(capture(result.stdout).args[2]).toBe("0.0.0.0");
  });
  it("fails an occupied port without changing it", async () => {
    const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const result = await run(fixture(), [], { DEVIN_WEB_PORT: String(port) });
      expect(result.code).not.toBe(0); expect(result.stderr).toMatch(/port|EADDRINUSE/i); expect(result.stdout).not.toContain("CAPTURE");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("prints help without dependencies, a build, or state changes", async () => {
    const root = fixture(false); rmSync(join(root, "node_modules"), { recursive: true });
    const result = await run(root, ["--help"]); expect(result.code).toBe(0); expect(result.stdout).toContain("Usage:"); expect(existsSync(join(root, "state"))).toBe(false);
  });
  it.each([false, true])("keeps standalone state owner-only (existing=%s)", async (existing) => {
    const root = fixture(); const state = join(root, "state");
    if (existing) { mkdirSync(state); chmodSync(state, 0o775); }
    const result = await run(root);
    expect(result.code).toBe(0);
    expect(statSync(state).mode & 0o777).toBe(0o700);
  });
  it("fails before spawning Next when state cannot be prepared", async () => {
    const root = fixture(); const state = join(root, "state");
    writeFileSync(state, "keep existing file");
    const result = await run(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/state/i);
    expect(result.stdout).not.toContain("CAPTURE");
    expect(readFileSync(state, "utf8")).toBe("keep existing file");
  });
  it("rejects an installed native dependency whose binding cannot load", async () => {
    const root = fixture(); mkdirSync(join(root, "node_modules/node-pty"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "1", "node-pty": "1" } }));
    writeFileSync(join(root, "node_modules/node-pty/package.json"), JSON.stringify({ main: "index.js" }));
    writeFileSync(join(root, "node_modules/node-pty/index.js"), 'require("./build/Release/pty.node")');
    const result = await run(root); expect(result.code).not.toBe(0); expect(result.stderr).toMatch(/dependencies/); expect(existsSync(join(root, "state"))).toBe(false);
  });
  it("rejects missing dependencies before changing state", async () => {
    const root = fixture(); rmSync(join(root, "node_modules"), { recursive: true });
    const result = await run(root); expect(result.code).not.toBe(0); expect(result.stderr).toContain("pnpm install"); expect(existsSync(join(root, "state"))).toBe(false);
  });
  it("ctl uses PORT fallback and limits the orphan check to its selected CLI", async () => {
    const root = fixture();
    writeFileSync(join(root, "bin/devin-acpd.mjs"), 'process.exit(1)');
    const result = await exec("bash", [join(root, "bin/devin-web-ctl"), "start"], {
      env: env(root, { PORT: "39217", DEVIN_WEB_DEVIN_BIN: "/isolated/bin/fake-acp.mjs" }), timeout: 10000,
    }).catch((error) => error);
    expect(result.code).not.toBe(0);
    expect(readFileSync(join(root, "state/pgrep-args"), "utf8")).toContain("/isolated/bin/fake-acp\\.mjs acp");
    expect(existsSync(join(root, "state/pid"))).toBe(false);
    expect(existsSync(join(root, "state/web-watch.pid"))).toBe(false);
  }, 15000);
  it("ctl preflight preserves an actual running process on restart failure", async () => {
    const root = fixture(false); mkdirSync(join(root, "state"));
    const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    ownedProcesses.push(sleeper.pid!); sleeper.unref();
    writeFileSync(join(root, "state/pid"), String(sleeper.pid)); writeFileSync(join(root, "state/web.disabled"), "keep");
    const result = await ctl(root, ["restart"], { PORT: await freePort(), DEVIN_WEB_ACPD: "0" });
    expect(result.code).not.toBe(0); expect(alive(sleeper.pid!)).toBe(true);
    expect(readFileSync(join(root, "state/pid"), "utf8")).toBe(String(sleeper.pid));
    expect(readFileSync(join(root, "state/web.disabled"), "utf8")).toBe("keep");
  });
  it("ctl starts on PORT and carries custom dist and clean socket settings through restart", async () => {
    const root = serviceFixture(); const port = await freePort();
    mkdirSync(join(root, "custom-build")); writeFileSync(join(root, "custom-build/BUILD_ID"), "build");
    const settings = { PORT: port, DEVIN_WEB_ACPD: "0", DEVIN_WEB_DIST_DIR: "custom-build", DEVIN_WEB_ACP_SOCK: "/unrelated-acp", DEVIN_WEB_HOST_SOCK: "/unrelated-host", HOST: "0.0.0.0" };
    try {
      expect((await ctl(root, ["start"], settings)).code).toBe(0);
      const before = readFileSync(join(root, "state/pid"), "utf8");
      expect((await ctl(root, ["restart"], settings)).code).toBe(0);
      expect(readFileSync(join(root, "state/pid"), "utf8")).not.toBe(before);
      const child = JSON.parse(readFileSync(join(root, "state/child-env.json"), "utf8"));
      expect(child.PORT).toBe(port); expect(child.DEVIN_WEB_PORT).toBe(port); expect(child.DEVIN_WEB_DIST_DIR).toBe("custom-build");
      expect(child.DEVIN_WEB_ACP_SOCK).toBeUndefined(); expect(child.DEVIN_WEB_HOST_SOCK).toBeUndefined(); expect(child.DEVIN_WEB_ACP_FALLBACK).toBe("0");
    } finally { await ctl(root, ["stop", "--all"], settings); }
  }, 30000);
  it("ctl rejects a restart onto a foreign occupied port before stopping its running web", async () => {
    const root = serviceFixture(); const settings = { PORT: await freePort(), DEVIN_WEB_ACPD: "0" };
    const foreign = createServer(); await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
    try {
      expect((await ctl(root, ["start"], settings)).code).toBe(0);
      const pid = readFileSync(join(root, "state/pid"), "utf8");
      const occupied = String((foreign.address() as { port: number }).port);
      const result = await ctl(root, ["restart"], { ...settings, DEVIN_WEB_PORT: occupied });
      expect(result.code).not.toBe(0); expect(result.stderr).toMatch(/port|listen/);
      expect(readFileSync(join(root, "state/pid"), "utf8")).toBe(pid);
      expect(alive(Number(pid))).toBe(true);
      expect((await fetch(`http://127.0.0.1:${settings.PORT}`)).status).toBe(200);
    } finally {
      await ctl(root, ["stop", "--all"], settings);
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  }, 30000);
  it("ctl cleans a daemon created by a failed web start", async () => {
    const root = serviceFixture(); const settings = { PORT: await freePort(), FAIL_NEXT: "1", DEVIN_WEB_ACP_FALLBACK: "1", DEVIN_WEB_DEVIN_BIN: "/isolated/fake-acp" };
    const result = await ctl(root, ["start"], settings);
    expect(result.code).not.toBe(0);
    const pid = Number(readFileSync(join(root, "state/created-acpd"), "utf8"));
    expect(alive(pid)).toBe(false); expect(existsSync(join(root, "state/web-watch.pid"))).toBe(false);
    expect(existsSync(join(root, "state/pid"))).toBe(false);
  });
  it("ctl keeps an existing daemon alive after a failed web restart", async () => {
    const root = serviceFixture(); const settings = { PORT: await freePort(), DEVIN_WEB_DEVIN_BIN: "/isolated/fake-acp", DEVIN_WEB_ACPD_PIDFILE: join(root, "state/custom-acpd.pid"), DEVIN_WEB_ACP_FALLBACK: "1" };
    try {
      const first = await ctl(root, ["start"], settings); expect(first.code, first.stderr).toBe(0);
      const pid = Number(readFileSync(join(root, "state/custom-acpd.pid"), "utf8"));
      const failed = await ctl(root, ["restart"], { ...settings, FAIL_NEXT: "1" }); expect(failed.code).not.toBe(0);
      expect(alive(pid)).toBe(true); expect(readFileSync(join(root, "state/custom-acpd.pid"), "utf8")).toBe(String(pid));
      expect(JSON.parse(readFileSync(join(root, "state/child-env.json"), "utf8")).DEVIN_WEB_ACP_FALLBACK).toBe("0");
    } finally { await ctl(root, ["stop", "--all"], settings); }
  }, 30000);
  it("ctl restart rejects missing build without deleting disabled or pid markers", async () => {
    const root = fixture(false); mkdirSync(join(root, "state"));
    writeFileSync(join(root, "state/pid"), "2147483647"); writeFileSync(join(root, "state/web.disabled"), "keep");
    let result; try { result = await exec("bash", [join(root, "bin/devin-web-ctl"), "restart"], { env: env(root, { DEVIN_WEB_ACPD: "0", PORT: "39181" }), timeout: 10000 }); }
    catch (e) { result = e as { stderr: string }; }
    // Old ctl arms a watch; always terminate that fixture process before assertions.
    const watch = join(root, "state/web-watch.pid");
    if (existsSync(watch)) { try { process.kill(Number(readFileSync(watch, "utf8")), "SIGTERM"); } catch {} }
    expect(result.stderr).toMatch(/pnpm build/);
    expect(readFileSync(join(root, "state/web.disabled"), "utf8")).toBe("keep");
    expect(readFileSync(join(root, "state/pid"), "utf8")).toBe("2147483647");
    expect(existsSync(watch)).toBe(false);
  });
});
