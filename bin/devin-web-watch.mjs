#!/usr/bin/env node
// devin-web-watch — bring devin-web back when it dies unattended.
//
// Spawned (setsid) by `devin-web-ctl start`, so it survives in its own
// session while the web lives and dies. Every INTERVAL_MS it checks
// /api/health; a pid-dead server gets `ctl start` after FAILS_NEEDED
// consecutive failures (~30s of confirmed-down — a normal restart's brief
// gap never reaches that). `ctl stop` drops $STATE/web.disabled first —
// an intentional stop stays down. A live pid that fails health is logged
// but left alone: ctl start would no-op on it anyway, and a compiling dev
// server must not be bounced.
import { processOwnership, writeProcessIdentity, removeProcessIdentity } from "./process-identity.mjs";
import { stateDir } from "../lib/paths.mjs";
import { appendFileSync, copyFileSync, existsSync, statSync, renameSync, truncateSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE = stateDir();
const PORT = process.env.DEVIN_WEB_PORT ?? "7100";
const HEALTH = `http://127.0.0.1:${PORT}/api/health`;
const DISABLED = join(STATE, "web.disabled");
const WEB_PIDFILE = join(STATE, "pid");
const PIDFILE = join(STATE, "web-watch.pid");
const LOG = join(STATE, "web-watch.log");
const CTL = join(ROOT, "bin/devin-web-ctl");

const INTERVAL_MS = 15_000;
const FAILS_NEEDED = 2;
const START_COOLDOWN_MS = 60_000; // don't spam `ctl start` while it's failing

const LOG_MAX = 1024 * 1024; // rotate like server/acpd logs — one generation
const SERVICE_LOG_MAX = 5 * 1024 * 1024; // same threshold ctl uses at start
const SERVICE_LOGS = [join(STATE, "server.log"), join(STATE, "acpd.log")];
const log = (m) => {
  try {
    if (statSync(LOG).size > LOG_MAX) renameSync(LOG, `${LOG}.1`);
  } catch {}
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`);
  } catch {
    /* state dir gone — nothing to log to */
  }
};

/** server.log/acpd.log are held open by their writers — an append-mode fd
 *  follows a rename, so the only rotation that sticks on a live process is
 *  copy+truncate (O_APPEND seeks to the new end on every write). A line or
 *  two written between the copy and the truncate can be lost — acceptable
 *  for logs. Runs on every tick so weeks-long processes can't grow a log
 *  without bound (ctl's mv at start only covers restarts). */
export function rotateServiceLog(path, max = SERVICE_LOG_MAX) {
  try {
    if (statSync(path).size <= max) return false;
    copyFileSync(path, `${path}.1`);
    truncateSync(path, 0);
    return true;
  } catch {
    return false;
  }
}

const rotateServiceLogs = () => {
  for (const p of SERVICE_LOGS) {
    if (rotateServiceLog(p)) log(`rotated ${p} (>5MB)`);
  }
};

const webPid = () => {
  const owned = processOwnership(WEB_PIDFILE, "web");
  // Unknown live ownership must not trigger a replacement launch.
  return owned.status === "owned" ? owned.record.pid : owned.status === "unverified" ? -1 : 0;
};

let fails = 0;
let lastStart = 0;
let noted = ""; // log state transitions once, not every poll
const note = (key, m) => {
  if (noted !== key) {
    noted = key;
    log(m);
  }
};

const tick = async () => {
  // service logs rotate even while the web is intentionally down — acpd
  // (and a stopped web's final writes) can still be growing them
  rotateServiceLogs();
  if (existsSync(DISABLED)) {
    note("disabled", "web.disabled present — intentional stop, standing down");
    fails = 0;
    return;
  }
  let ok = false;
  try {
    const r = await fetch(HEALTH, { signal: AbortSignal.timeout(5000) });
    ok = r.ok;
  } catch {}
  if (ok) {
    if (noted === "down") log("health OK — web is back up");
    noted = "up";
    fails = 0;
    return;
  }
  fails++;
  const pid = webPid();
  if (pid < 0) {
    note("unverified", "health failing and web process ownership unverified — refusing a replacement");
    return;
  }
  if (pid > 0) {
    note("wedged", `health failing but web pid ${pid} alive — leaving it`);
    return;
  }
  noted = "down";
  if (fails < FAILS_NEEDED || Date.now() - lastStart < START_COOLDOWN_MS) return;
  lastStart = Date.now();
  log(`web down (pid dead, ${fails} consecutive checks) — ${CTL} start`);
  try {
    const out = execFileSync(CTL, ["start"], { timeout: 60_000 }).toString();
    log(`start: ${out.trim().replace(/\n/g, " | ")}`);
  } catch (e) {
    log(`start FAILED: ${e.message}`);
  }
};

// tests import rotateServiceLog — side effects (pidfile, tick loop) only
// when run as a script, like devin-web-idle-restart.mjs
const IS_MAIN =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const identity = writeProcessIdentity(PIDFILE, "watch");
  process.on("exit", () => removeProcessIdentity(PIDFILE, identity));
  log(`watching ${HEALTH} — ctl start after ${FAILS_NEEDED} consecutive failures`);
  // keep the interval REF'd — it IS this process's reason to stay alive
  setInterval(() => void tick().catch((e) => log(`tick error: ${e.message}`)), INTERVAL_MS);
  void tick().catch((e) => log(`tick error: ${e.message}`));
}
