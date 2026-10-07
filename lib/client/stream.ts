"use client";

/**
 * Client side of the multiplexed stream — one EventSource per tab carrying
 * every subscription (session events, terminal output, transcript items,
 * global events). Components subscribe by key; the module reconciles the
 * desired set with the server via POST /api/stream/subscribe, and SSE ids +
 * server-side cursors handle reconnect gaps.
 */

export type StreamHandler = (msg: Record<string, unknown>) => void;

interface Want {
  kind: "global" | "session" | "transcript" | "terminal" | "view";
  id: string;
  handlers: Set<StreamHandler>;
}

export const connId =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

const wanted = new Map<string, Want>();
let es: EventSource | null = null;
let open = false;
let ready = false;
let syncing = false;
let syncAgain = false;
// A new view reducer needs a snapshot even if the server retained its topic.
// Tokens keep an older in-flight acknowledgment from consuming a newer mount.
const forceSnapshots = new Map<string, number>();
let forceToken = 0;
let syncRetry: ReturnType<typeof setTimeout> | null = null;
let syncFailures = 0;

function clearSyncRetry() {
  if (syncRetry) clearTimeout(syncRetry);
  syncRetry = null;
}

function requestSnapshot(key: string, fresh = false) {
  if (!wanted.has(key)) return;
  if (fresh || !forceSnapshots.has(key)) {
    forceSnapshots.set(key, ++forceToken);
    syncFailures = 0;
    clearSyncRetry();
  }
}
/** server process id from the last `ready` — a change means a restart */
let epoch: string | null = null;
/** newest SSE id received — handed to a re-created EventSource as ?last= */
let lastEventId = "";
let retryMs = 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(connected: boolean) => void>();
const restartListeners = new Set<() => void>();

/** Diagnostic breadcrumb — POSTed to /api/diag (logged in server.log) so
 *  mobile-side failures can be correlated with stream/probe logs. */
export function diag(t: string, extra?: Record<string, unknown>) {
  try {
    // .catch is mandatory, not cosmetic: a rejected beacon re-enters
    // unhandledrejection, which posts another beacon — a self-feeding
    // jsrej flood while the network is down (observed: 14 in one burst)
    void fetch("/api/diag", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", "x-devin-web": "1" },
      body: JSON.stringify({ t, c: connId, at: Date.now(), ...extra }),
    }).catch(() => {});
  } catch {
    /* best effort */
  }
}

if (typeof window !== "undefined") {
  addEventListener("pagehide", (e) =>
    diag("pagehide", { persisted: (e as PageTransitionEvent).persisted }),
  );
  addEventListener("pageshow", (e) =>
    diag("pageshow", { persisted: (e as PageTransitionEvent).persisted }),
  );
  document.addEventListener("visibilitychange", () => {
    diag("vis", { s: document.visibilityState });
    // the server skips push notifications for sessions a visible tab shows
    void fetch("/api/stream/subscribe", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", "x-devin-web": "1" },
      body: JSON.stringify({ connId, visible: document.visibilityState === "visible" }),
    }).catch(() => {});
  });
  addEventListener("error", (e) => {
    const ev = e as ErrorEvent;
    diag("jserr", {
      m: ev.message?.slice(0, 200),
      s: ev.error?.stack?.slice(0, 600),
    });
  });
  addEventListener("unhandledrejection", (e) => {
    const r = (e as PromiseRejectionEvent).reason;
    diag("jsrej", {
      m: String(r).slice(0, 200),
      s: (r as Error | undefined)?.stack?.slice(0, 600),
    });
  });
}

const inputSeqs = new Map<string, number>();
const inputBufs = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null; chain: Promise<void>; pending: number }>();

/** keys already reported as handler-less — the beacon fires once per key
 *  per page so a live event stream can't flood /api/diag */
const noHandlerSeen = new Set<string>();

function dispatch(msg: Record<string, unknown>) {
  const kind = msg.kind as string;
  if (kind === "meta") return;
  const key = `${kind}:${(msg.id as string) ?? ""}`;
  const w = wanted.get(key);
  if (!w && !noHandlerSeen.has(key)) {
    noHandlerSeen.add(key);
    diag("nohandler", { key });
  }
  // isolate handlers — one throwing must not starve the others or break
  // the stream loop; the throw still surfaces via the diag beacon
  if (w) {
    for (const fn of w.handlers) {
      try {
        fn(msg);
      } catch (err) {
        diag("jsrej", {
          m: `dispatch:${key}: ${err instanceof Error ? err.message : err}`,
          s: (err as Error | undefined)?.stack?.slice(0, 600),
        });
      }
    }
  }
}

/** A non-200 answer (e.g. a proxy 502 while the server restarts) closes an
 *  EventSource for good — build a fresh one with exponential backoff. */
function scheduleReconnect() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    ensureStream();
  }, retryMs);
  retryMs = Math.min(retryMs * 2, 15_000);
}

function ensureStream() {
  if (es) return;
  const q = new URLSearchParams({ c: connId });
  if (lastEventId) q.set("last", lastEventId);
  q.set("v", document.visibilityState === "visible" ? "1" : "0");
  const src = new EventSource(`/api/stream?${q.toString()}`);
  es = src;
  src.onopen = () => {
    if (es !== src) return;
    open = true;
    retryMs = 1000;
    diag("es-open");
    for (const fn of listeners) fn(true);
    syncSubsInBackground();
  };
  src.onerror = () => {
    if (es !== src) return;
    clearSyncRetry();
    open = false;
    ready = false;
    diag("es-error", { rs: src.readyState });
    for (const fn of listeners) fn(false);
    if (src.readyState === EventSource.CLOSED) {
      src.close();
      if (es === src) es = null;
      scheduleReconnect();
    }
  };
  src.onmessage = (m) => {
    if (es !== src) return;
    if (m.lastEventId) lastEventId = m.lastEventId;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(m.data);
    } catch {
      return;
    }
    if (msg.kind === "meta" && msg.type === "ready") {
      const next = typeof msg.epoch === "string" ? msg.epoch : null;
      if (next && epoch && next !== epoch) {
        // a new server process: its seqs and cursors restarted from zero
        lastSynced.clear();
        // A POST may have installed topics before this stream attached. Its
        // pre-ready snapshots are cleared by restart listeners, so force new
        // ones even when the replacement server already owns these topics.
        for (const [key, w] of wanted) {
          if (w.kind === "view") requestSnapshot(key, true);
        }
        for (const fn of [...restartListeners]) fn();
      }
      if (next) epoch = next;
      ready = true;
      syncFailures = 0;
      clearSyncRetry();
      syncSubsInBackground();
      return;
    }
    dispatch(msg);
  };
}

const lastSynced = new Map<string, { kind: Want["kind"]; id: string }>();

/** Push the desired subscription set to the server. Always sends the full
 *  wanted set as `add` — the server dedupes existing subs, and re-sending
 *  everything self-heals after a server-side connection GC. */
async function syncSubs() {
  if (!open || !ready) return; // retried on open/ready
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    const syncEpoch = epoch;
    const forced = new Map(forceSnapshots);
    const add = [...wanted.values()].map((w) => ({ kind: w.kind, id: w.id }));
    const remove = [...lastSynced.entries()]
      .filter(([k]) => !wanted.has(k) || forced.has(k))
      .map(([, v]) => v);
    // Force even an unknown retained server topic (e.g. mounted offline).
    for (const spec of add) {
      if (forced.has(`${spec.kind}:${spec.id}`) &&
          !remove.some(r => r.kind === spec.kind && r.id === spec.id)) {
        remove.push(spec);
      }
    }
    if (!add.length && !remove.length) return;
    // A lost response may still have installed these topics server-side.
    // Remember possible additions so a later ownership change removes them.
    for (const spec of add) lastSynced.set(`${spec.kind}:${spec.id}`, spec);
    const res = await fetch("/api/stream/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-devin-web": "1" },
      body: JSON.stringify({ connId, add, remove }),
    });
    diag("subsync", {
      a: add.length,
      r: remove.length,
      s: res.status,
      // the topics the server now owes us — a missing session sub here means
      // the live channel was never registered server-side for this tab
      k: add.map((s) => `${s.kind}:${s.id}`).join(",").slice(0, 300),
    });
    if (res.ok && epoch === syncEpoch) {
      lastSynced.clear();
      // Only the sent snapshot was acknowledged. `wanted` may have changed
      // while fetch was pending; the next pass must remove its old topics.
      for (const spec of add) lastSynced.set(`${spec.kind}:${spec.id}`, spec);
      for (const [key, token] of forced) {
        if (forceSnapshots.get(key) === token) forceSnapshots.delete(key);
      }
      syncFailures = 0;
      clearSyncRetry();
    }
  } catch {
    /* next sync retries */
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      syncSubsInBackground();
    } else if (forceSnapshots.size && open && ready && !syncRetry && syncFailures < 3) {
      // A quiet view must recover even when no later frame triggers a gap.
      // After three retries keep intent queued; the next ready re-arms it.
      const delay = 250 * 2 ** syncFailures++;
      syncRetry = setTimeout(() => {
        syncRetry = null;
        syncSubsInBackground();
      }, delay);
    }
  }
}

/** Own the detached promise as well as errors from syncSubs' finally block. */
function syncSubsInBackground() {
  void syncSubs().catch((err: unknown) => {
    diag("jsrej", { m: `subsync:${err instanceof Error ? err.message : String(err)}` });
  });
}

/** Subscribe to a stream topic — multiple handlers per topic are fine.
 *  Returns an unsubscribe function. */
export function streamSub(kind: Want["kind"], id: string, handler: StreamHandler): () => void {
  ensureStream();
  const key = `${kind}:${id}`;
  let w = wanted.get(key);
  if (!w) wanted.set(key, (w = { kind, id, handlers: new Set() }));
  w.handlers.add(handler);
  if (kind === "view") requestSnapshot(key, true);
  syncSubsInBackground();
  return () => {
    w.handlers.delete(handler);
    if (!w.handlers.size) {
      wanted.delete(key);
      forceSnapshots.delete(key);
      if (!forceSnapshots.size) clearSyncRetry();
    }
    syncSubsInBackground();
  };
}

/** Queue a cursor-zero subscription refresh, serialized with reconciliation.
 *  Intent survives disconnection; repeated repair calls coalesce. The promise
 *  acknowledges queued intent, not delivery, so it never leaves a caller
 *  waiting for a disconnected or unmounted consumer. */
export function resubscribe(kind: Want["kind"], id: string): Promise<void> {
  const key = `${kind}:${id}`;
  if (wanted.has(key)) {
    requestSnapshot(key);
    syncSubsInBackground();
  }
  return Promise.resolve();
}

/** Connection state changes (for UI banners). */
export function onStreamState(fn: (connected: boolean) => void): () => void {
  listeners.add(fn);
  fn(open);
  return () => listeners.delete(fn);
}

/** Fires when the stream reconnects to a different server process. Any
 *  client-side cursor (event seq, byte offset) is meaningless afterwards. */
export function onServerRestart(fn: () => void): () => void {
  restartListeners.add(fn);
  return () => {
    restartListeners.delete(fn);
  };
}

/** Ordered, batched terminal input — accumulates keystrokes ~40ms and posts
 *  them as one sequenced message; posts are serialized per terminal so the
 *  wire order always matches seq order. */
export function sendTerminalInput(terminalId: string, data: string) {
  let buf = inputBufs.get(terminalId);
  if (!buf) inputBufs.set(terminalId, (buf = { text: "", timer: null, chain: Promise.resolve(), pending: 0 }));
  buf.text += data;
  if (buf.timer) return;
  buf.timer = setTimeout(() => {
    buf.timer = null;
    const text = buf.text;
    buf.text = "";
    const seq = (inputSeqs.get(terminalId) ?? 0) + 1;
    inputSeqs.set(terminalId, seq);
    buf.pending++;
    buf.chain = buf.chain
      .then(() =>
        fetch(`/api/terminals/${terminalId}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-devin-web": "1" },
          body: JSON.stringify({ c: connId, data: text, seq }),
        }).then(() => undefined).catch(() => {}),
      )
      .finally(() => {
        // drop the batch state once idle — seq must persist (the server
        // tracks per-connection counters until the subscription ends)
        buf.pending--;
        if (!buf.pending && !buf.text && !buf.timer && inputBufs.get(terminalId) === buf) {
          inputBufs.delete(terminalId);
        }
      });
  }, 40);
}
