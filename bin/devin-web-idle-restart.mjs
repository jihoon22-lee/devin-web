#!/usr/bin/env node
// devin-web-idle-restart — wait until every session is idle, then restart
// devin-acpd. Spawned detached (setsid) by `devin-web-ctl acpd restart
// --when-idle`: an acpd restart kills the agent, so it must wait for a
// quiet gap — and it must survive the death of the session that asked for
// it (the asking session's own turn may be what we're waiting on).
//
// Busy source of truth: the web's /api/sessions `running` flags — polling
// HTTP never touches the daemon socket. A socket connect that speaks gets
// ADOPTED as the client on first data and would displace the live web
// bridge, so `_devin-web/shim_state` is used ONLY while the web is down
// (no web → no live client → nothing to displace).
import { writeProcessIdentity, removeProcessIdentity, processOwnership } from "./process-identity.mjs";
import { stateDir } from "../lib/paths.mjs";
import { connect } from "node:net";
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STATE = stateDir();
const PORT = process.env.DEVIN_WEB_PORT || "7100";
const SOCK = process.env.DEVIN_WEB_ACP_SOCK || join(STATE, "acp.sock");
const ACPD_PIDFILE = process.env.DEVIN_WEB_ACPD_PIDFILE ?? join(STATE, "acpd.pid");
const MY_PIDFILE = join(STATE, "acpd-idle-restart.pid");
const LOG = join(STATE, "acpd-watch.log");
// daemon's own status file (lib/acp/daemon.mjs writeStatus) — sits next to
// the socket, updated on every adopt/drop
const STATUS = join(dirname(SOCK), "acpd-status.json");
const SESSIONS_URL = `http://127.0.0.1:${PORT}/api/sessions`;
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
const CTL = join(dirname(fileURLToPath(import.meta.url)), "devin-web-ctl");
const POLL_MS = 15_000;
const IDLE_POLLS_NEEDED = 2;      // ~30s of quiet before firing
const WEB_DOWN_FALLBACK_AFTER = 2; // only probe the socket after 2 web failures
const MAX_WAIT_MS = 6 * 3600e3;

const log = (m) => {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] idle-restart: ${m}\n`); } catch {}
};

let identity;
const cleanup = (code) => {
  if (identity) removeProcessIdentity(MY_PIDFILE, identity);
  process.exit(code);
};

const currentAcpdIdentity = () => processOwnership(ACPD_PIDFILE, "acpd");
const startIdentity = currentAcpdIdentity();
const startPid = startIdentity.record?.pid;

const deadline = Date.now() + MAX_WAIT_MS;
let idlePolls = 0;
let webDownPolls = 0;

/** running-session count, or null when undeterminable. */
async function runningCount() {
  try {
    const r = await fetch(SESSIONS_URL, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(String(r.status));
    const body = /** @type {any} */ (await r.json());
    const list = Array.isArray(body) ? body : body?.sessions;
    if (!Array.isArray(list)) return null;
    webDownPolls = 0;
    return list.filter((s) => s && s.running === true).length;
  } catch {
    webDownPolls++;
    if (webDownPolls < WEB_DOWN_FALLBACK_AFTER) return null;
    // "HTTP failed" ≠ "web down": a slow /api/sessions (or a 500 while acp
    // restarts) happens with the bridge still attached to the daemon
    if (daemonHasClient()) {
      log("web unreachable but acpd still has a client attached — not probing the socket");
      return null;
    }
    return shimBusy();
  }
}

/** The socket fallback is safe ONLY with no client attached: a probe that
 *  speaks gets ADOPTED and displaces a live-but-slow web bridge (its
 *  in-flight prompts reject, queued ones follow). acpd-status.json says who
 *  is attached — reading it touches nothing. Unknown → assume attached. */
export function daemonHasClient(statusPath = STATUS) {
  try {
    return JSON.parse(readFileSync(statusPath, "utf8"))?.connectedClient != null;
  } catch {
    return true;
  }
}

/** One-shot shim_state query — safe ONLY while the web is down (nothing
 *  live to displace). Returns busy-session count or null. */
function shimBusy() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(v);
    };
    const sock = connect(SOCK);
    let buf = "";
    sock.once("connect", () => {
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_devin-web/shim_state", params: {} }) + "\n");
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      for (;;) {
        const i = buf.indexOf("\n");
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return finish(null); // wire junk — protocol confusion, bail
        }
        // the daemon writes a `_devin-web/hello` notification BEFORE it
        // answers (and may interleave other pushes) — only the response
        // carrying our id ends the wait; anything else is a notification.
        if (msg.id !== 1) continue;
        const sessions = msg?.result?.sessions;
        return finish(Array.isArray(sessions) ? sessions.filter((s) => s && s.busy === true).length : null);
      }
    });
    sock.on("error", () => finish(null));
    sock.on("close", () => finish(null));
    setTimeout(() => finish(null), 5000).unref?.();
  });
}

async function tick() {
  const now = currentAcpdIdentity();
  if (startIdentity.status !== "owned" || now.status !== "owned" || JSON.stringify(now.record) !== JSON.stringify(startIdentity.record)) {
    log(`acpd pid changed ${startPid} → ${now} — restarted by someone else; done`);
    return cleanup(0);
  }
  if (Date.now() > deadline) {
    log("giving up — sessions still busy after 6h");
    return cleanup(0);
  }
  const running = await runningCount();
  if (running == null) {
    idlePolls = 0;
    log("busy state unknown — keep waiting");
  } else if (running === 0) {
    idlePolls++;
    log(`all sessions idle (${idlePolls}/${IDLE_POLLS_NEEDED})`);
    if (idlePolls >= IDLE_POLLS_NEEDED) {
      log("running: devin-web-ctl acpd restart --force");
      try {
        const out = execFileSync(CTL, ["acpd", "restart", "--force"], { encoding: "utf8", timeout: 60_000 });
        log(out.trim().replace(/\n/g, " | "));
      } catch (e) {
        log(`restart FAILED: ${e.message}`);
        return cleanup(1);
      }
      // poke health so the web bridge re-attaches to the fresh daemon at once
      try { await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) }); } catch {}
      log("done");
      return cleanup(0);
    }
  } else {
    idlePolls = 0;
  }
  setTimeout(tick, POLL_MS);
}

function main() {
  identity = writeProcessIdentity(MY_PIDFILE, "idle");
  log(`watching for an idle gap to restart acpd (was pid ${startPid ?? "?"})`);
  tick();
}

// tests import shimBusy — side effects (pidfile, tick loop) only under argv
const IS_MAIN =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) main();

export { shimBusy, runningCount };
