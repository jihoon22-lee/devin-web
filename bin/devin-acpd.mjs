#!/usr/bin/env node
// devin-acpd — daemon that owns `devin acp` and serves it over a unix socket.
// Started standalone (own process group via setsid in bin/devin-web-ctl) so a
// web-server restart never kills the agent or its in-flight turn.
//
// Env:
//   DEVIN_WEB_STATE_DIR   state dir (see lib/paths.mjs for precedence)
//   DEVIN_WEB_ACP_SOCK    socket path (default $STATE_DIR/acp.sock)
//   DEVIN_WEB_HOST_SOCK   host socket path (default $STATE_DIR/host.sock) —
//                         terminal PTYs live here so they survive web restarts
//   DEVIN_WEB_DEVIN_BIN   devin binary (default "devin")
//   DEVIN_WEB_FS_ROOTS    comma-separated fs allowlist for local fs serving
import { stateDir } from "../lib/paths.mjs";
import { createDaemon } from "../lib/acp/daemon.mjs";
import { createHost } from "../lib/acp/host.mjs";
import { join } from "node:path";
import { writeProcessIdentity, removeProcessIdentity } from "./process-identity.mjs";

const STATE_DIR = stateDir();
const sockPath = process.env.DEVIN_WEB_ACP_SOCK ?? join(STATE_DIR, "acp.sock");
const hostSock = process.env.DEVIN_WEB_HOST_SOCK ?? join(STATE_DIR, "host.sock");
const bin = process.env.DEVIN_WEB_DEVIN_BIN ?? "devin";
const fsRoots = (process.env.DEVIN_WEB_FS_ROOTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const log = (m) => console.log(`[devin-acpd ${new Date().toISOString()}] ${m}`);

const daemon = createDaemon({
  sockPath,
  bin,
  fsRoots,
  onEvent: (e) => log(e.message ?? JSON.stringify(e)),
});

await daemon.start();
// host channel (Phase 2-1) — terminal PTYs live in THIS process, not the web,
// so a web restart never kills an exec or a user shell. Same process, its own
// socket — acp.sock stays a pure ACP passthrough.
const host = createHost({
  sockPath: hostSock,
  onEvent: (e) => log(`[host] ${e.message ?? JSON.stringify(e)}`),
  // Phase 2-2/2-3: the host answers ev/hello + sessions/state from the
  // daemon's loaded/busy tracking — same data as _devin-web/shim_state
  sessionsProvider: () => daemon.sessionsState(),
});
await host.start();
// own the pidfile — a `setsid … &` caller's $! can be a short-lived wrapper,
// so the only trustworthy pid is ours
const PIDFILE = process.env.DEVIN_WEB_ACPD_PIDFILE ?? join(STATE_DIR, "acpd.pid");
const identity = writeProcessIdentity(PIDFILE, "acpd");
log(`listening on ${sockPath} + ${hostSock} (pid ${process.pid})`);

const shutdown = async (sig) => {
  log(`${sig} — shutting down`);
  await daemon.stop();
  await host.stop();
  removeProcessIdentity(PIDFILE, identity);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// The daemon is the single point of failure for the agent it owns — a bug in
// wire-data handling must NEVER take the process down (the acp child would be
// orphaned holding session locks while the web spawns a second agent). Log
// and keep going; the per-line try/catch in daemon.mjs is the first defense.
process.on("uncaughtException", (e) => log(`uncaughtException (survived): ${e instanceof Error ? (e.stack ?? e.message) : e}`));
process.on("unhandledRejection", (e) => log(`unhandledRejection (survived): ${e instanceof Error ? (e.stack ?? e.message) : e}`));
