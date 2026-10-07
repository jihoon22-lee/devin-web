import { NextResponse } from "next/server";
import { manager } from "@/lib/state";
import { devinCliStatus } from "@/lib/devinCli";
import { daemonPidAlive, daemonStatus } from "@/lib/acp/transport";
import { hostClient } from "@/lib/acp/terminal";
import { streamStats } from "@/lib/stream/connections";
import { integrityCount } from "@/lib/integrityBeacon";
import { createCliSchemaHealthReader } from "@/lib/cliSchema";
import { stateStorage } from "@/lib/stateStorage";

export const dynamic = "force-dynamic";

const startedAt = Date.now();
const cliSchemaHealth = createCliSchemaHealthReader();

/** GET /api/health — liveness + component status for the sidebar badge.
 *  Spawn mode never starts acp just to report health (bridgePid stays null
 *  until something attaches). Daemon mode connects the socket — free, the
 *  daemon already owns acp — and may spawn only via the downed-daemon
 *  fallback path. `devin` comes from a CLI probe cached for 5 minutes. */
export async function GET() {
  const m = manager();
  let pid = m.bridgePid;
  let sessions = 0;
  let ds = null;
  // daemon mode: the bridge connects lazily, so a fresh web reports
  // alive:false while the daemon's acp is perfectly healthy. ensure()
  // only runs when DEVIN_WEB_ACP_SOCK is configured AND reachable — the
  // probe keeps a dead daemon from triggering the connector's spawn
  // fallback inside a passive poll.
  if (m.bridge.socketMode && !pid) {
    try {
      // probe first: ensure() falls back to spawning its own agent when the
      // daemon is down — a passive 30s status poll must never do that (two
      // agents then compete for the same session locks when acpd recovers).
      // pidfile check, NOT a socket connect: connecting displaces the live
      // client on older daemons.
      if (daemonPidAlive() === false) throw new Error("acpd not running");
      await m.bridge.ensure();
      ds = await m.bridge.daemonState();
    } catch {
      /* daemon down and fallback disabled/failed — report dead */
    }
    if (ds) {
      pid = ds.acpPid ?? null;
      sessions = ds.sessions.length;
    } else {
      pid = m.bridgePid; // fell back to spawn, or genuinely down
    }
  }
  try {
    // daemon state is authoritative — when it reported (even "0 sessions"),
    // a session/list roundtrip every poll just burns an ACP request
    if (pid && !sessions && !ds) {
      sessions = (await m.listSessions()).filter((s) => s.active).length;
    }
  } catch {
    /* acp mid-restart — report what we know */
  }
  // daemon circuit-breaker state — from the status FILE, never the socket
  // (a probe connect gets adopted as the client and displaces the bridge)
  const dStatus = m.bridge.socketMode ? daemonStatus() : null;
  // host.sock reachability — the daemon-side channel for terminals, the
  // event mirror, and session state (null = local mode, nothing to reach)
  const h = hostClient();
  let host: boolean | null = null;
  if (h) {
    host = h.available;
    if (!host) {
      try {
        await h.sessionsState(); // cheapest rpc — also kicks the reconnect
        host = true;
      } catch {
        host = false;
      }
    }
  }
  return NextResponse.json({
    ok: true,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    acp: {
      alive: pid != null,
      pid,
      // "daemon" = connected to devin-acpd (agent survives web restarts);
      // "spawn" = agent is our own child (legacy, dies with the web process)
      via: m.bridge.socketMode ? "daemon" : "spawn",
      degraded: dStatus?.degraded ?? null,
    },
    host,
    attached: sessions,
    // observability — a silently-dead mirror or a stalled resync shows up
    // here instead of looking like a frozen session
    stream: streamStats(),
    view: { sessions: m.view.size },
    // transcript regression alarm — client integrity beacons since boot
    integrity: integrityCount(),
    cliSchema: cliSchemaHealth(),
    storage: stateStorage(),
    devin: await devinCliStatus(),
  });
}
