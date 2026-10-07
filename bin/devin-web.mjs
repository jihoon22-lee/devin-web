#!/usr/bin/env node
// devin-web — web UI for Devin CLI.
// Usage: devin-web [--port N] [--host H] [--no-open] [--dev]
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stateDir as resolveStateDir } from "../lib/paths.mjs";
import { writeProcessIdentity, removeProcessIdentity } from "./process-identity.mjs";
import { checkPort, launchOptions, preflight } from "./runtime.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`devin-web — web UI for Devin CLI

Usage: devin-web [options]

Options:
  -p, --port <n>    Port: CLI > DEVIN_WEB_PORT > PORT > 7100; occupied ports fail
  -H, --host <h>    Host to bind (default: 127.0.0.1)
  --no-open         Do not open the browser automatically
  --dev             Run Next.js in dev mode (default: production; requires pnpm build)
  -h, --help        Show this help

Remote access (tailnet only): keep --host 127.0.0.1 and run
  tailscale serve --bg --https=<port> http://127.0.0.1:<port>
then open https://<device>.<tailnet>.ts.net:<port>/ from your other devices.
(Without --https, serve takes port 443 and replaces whatever is served there.)`);
  process.exit(0);
}

let options;
let nextBin;
try {
  options = launchOptions(args);
  nextBin = preflight(root, options);
  await checkPort(options.port, options.host);
} catch (error) {
  console.error(`devin-web: ${error.message}`);
  process.exit(1);
}
const { port, host, distDir } = options;
const prod = !options.dev;
const stateDir = resolve(resolveStateDir());
/** @type {NodeJS.ProcessEnv} */
const childEnv = {
  ...process.env,
  NODE_ENV: prod ? "production" : "development",
  DEVIN_WEB_STATE_DIR: stateDir,
  DEVIN_WEB_DIST_DIR: distDir,
  DEVIN_WEB_PORT: String(port),
  PORT: String(port),
};
if (process.env.DEVIN_WEB_ACPD === "0") {
  delete childEnv.DEVIN_WEB_ACP_SOCK;
  delete childEnv.DEVIN_WEB_HOST_SOCK;
}

// record our own pidfile — the same convention devin-acpd uses. ctl's
// `echo $!` could capture a short-lived launcher instead of the process
// that actually owns the lifecycle (the 9-19 stale-pidfile incident)
if (stateDir) {
  const pidfile = join(stateDir, "pid");
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const identity = writeProcessIdentity(pidfile, "web", childEnv);
    process.on("exit", () => removeProcessIdentity(pidfile, identity));
  } catch (error) {
    console.error(`devin-web: cannot prepare private state directory ${stateDir}: ${error.message}`);
    process.exit(1);
  }
}

// warn when the production build looks older than the sources it serves
// (max 300 files walked; skips silently on any fs hiccup)
if (prod) {
  try {
    const buildTime = statSync(resolve(root, distDir, "BUILD_ID")).mtimeMs;
    let newest = 0;
    let walked = 0;
    const walk = (dir) => {
      if (walked > 300) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (walked > 300) return;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (!e.name.startsWith(".") && e.name !== "node_modules") walk(p);
        } else {
          walked++;
          const m = statSync(p).mtimeMs;
          if (m > newest) newest = m;
        }
      }
    };
    for (const d of ["app", "components", "lib", "hooks", "bin", "public"]) {
      const p = join(root, d);
      if (existsSync(p)) walk(p);
    }
    for (const f of ["package.json", "next.config.ts", "next.config.mjs"]) {
      const p = join(root, f);
      if (existsSync(p)) newest = Math.max(newest, statSync(p).mtimeMs);
    }
    if (newest > buildTime) {
      console.warn(`devin-web: sources are newer than ${distDir}/ — run pnpm build to pick up recent changes`);
    }
  } catch {
    /* best-effort warning only */
  }
}

const nextArgs = prod ? ["start", "-H", host, "-p", String(port)] : ["dev", "-H", host, "-p", String(port)];

const urlHost = host === "0.0.0.0" || host === "::" ? "localhost" : host.includes(":") ? `[${host}]` : host;
const url = `http://${urlHost}:${port}`;

const child = spawn(process.execPath, [nextBin, ...nextArgs], {
  cwd: root,
  stdio: "inherit",
  env: childEnv,
});
// relay signals so killing this wrapper also takes down next-server
// (otherwise next-server survives as an orphan and keeps the port)
for (const sig of /** @type {NodeJS.Signals[]} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
  process.on(sig, () => child.kill(sig));
}
child.on("error", (error) => {
  console.error(`devin-web: failed to start Next.js: ${error.message}`);
  process.exit(1);
});
child.on("exit", (c, signal) => process.exit(c ?? (signal ? 1 : 0)));

if (!options.noOpen) {
  // open the browser once the server answers
  const deadline = Date.now() + 30000;
  const tryOpen = () => {
    fetch(url, { signal: AbortSignal.timeout(1000) })
      .then(() => openBrowser(url))
      .catch(() => {
        if (Date.now() < deadline) setTimeout(tryOpen, 500);
      });
  };
  setTimeout(tryOpen, 800);
}

function openBrowser(u) {
  const cmds = /** @type {[string, string[]][]} */ (
    process.platform === "darwin" ? [["open", [u]]] :
    process.platform === "win32" ? [["cmd", ["/c", "start", "", u]]] :
    [["xdg-open", [u]], ["wslview", [u]], ["sensible-browser", [u]]]
  );
  for (const [cmd, a] of cmds) {
    try {
      const p = spawn(cmd, /** @type {string[]} */ (a), { stdio: "ignore", detached: true });
      p.on("error", () => {});
      p.unref();
      return;
    } catch {
      /* try next */
    }
  }
}

console.log(`devin-web → ${url}`);
