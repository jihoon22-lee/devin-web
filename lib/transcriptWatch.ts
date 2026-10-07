import { watch, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { DEVIN_CLI_DIR } from "./locks";
import { hostClient } from "./acp/terminal";

const WAL = join(DEVIN_CLI_DIR, "sessions.db-wal");

const listeners = new Set<() => void>();
let watcher: ReturnType<typeof watch> | null = null;
let walWatching = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let daemonHooked = false;

function notifyAll() {
  if (timer) return;
  // leading-edge debounce: sqlite touches db/-wal/-shm on every commit
  timer = setTimeout(() => {
    timer = null;
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* listener error must not break the shared watcher */
      }
    }
  }, 60);
}

function ensureWatcher() {
  if (!watcher) {
    try {
      watcher = watch(DEVIN_CLI_DIR, (_ev, fname) => {
        if (fname?.startsWith("sessions.db")) notifyAll();
      });
      watcher.unref?.();
    } catch {
      watcher = null;
    }
  }
  // watchFile is a one-time registration — re-running it on every subscribe
  // would stack duplicate stat pollers when fs.watch itself failed
  if (!walWatching) {
    try {
      watchFile(WAL, { interval: 250 }, notifyAll); // backup trigger fs.watch can miss
      walWatching = true;
    } catch {
      /* no wal yet */
    }
  }
}

/** Re-fire listeners without a filesystem event — e.g. the manager's durable
 *  watermark advanced and rows withheld from transcript deltas are now
 *  deliverable. Shares the same 60ms debounce as real commits. */
export function pokeSessionsDb() {
  notifyAll();
}

/** Shared sessions.db commit notifier — one fs.watch + one WAL stat-poll for
 *  every consumer (transcript subs across all mux connections). */
export function onSessionsDbChange(fn: () => void): () => void {
  listeners.add(fn);
  ensureWatcher();
  // Phase 2-2: the daemon owns the durable db watcher — its _host/db_changed
  // push feeds the same debounced notify, so commits during a web restart
  // still arrive (local watch stays as the fallback trigger)
  if (!daemonHooked) {
    const h = hostClient();
    if (h) {
      daemonHooked = true;
      h.onDbChanged(() => notifyAll());
    }
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (walWatching) {
        try {
          unwatchFile(WAL, notifyAll);
        } catch {
          /* noop */
        }
        walWatching = false;
      }
    }
  };
}
