import { manager } from "@/lib/state";
import { terminalPool, type TerminalEvent } from "@/lib/acp/terminal";
import { maxNodeId, nodesAfter, openSessionsDb } from "@/lib/db";
import { onSessionsDbChange } from "@/lib/transcriptWatch";
import { scheduleCatchup } from "@/lib/searchIndex";
import { attachToolState, rowToItem, type TranscriptItem } from "@/lib/transcript";

/**
 * One multiplexed SSE connection per browser tab (3-4). A Connection holds
 * named subscriptions (terminal output, transcript watch,
 * global events, session views); each wire message carries a per-connection seq `n` sent as
 * the SSE id.
 *
 * Reconnect contract: every subscription remembers which wire message moved
 * its cursor where (`acks`). On reconnect the client's Last-Event-ID tells us
 * what it really received, so the cursor is rewound to that point and the sub
 * re-sends everything after it — in order, with no holes. Only `global`
 * messages (which carry no cursor) are replayed from the outbox.
 */

export type SubKind = "global" | "transcript" | "terminal" | "view";

export interface SubSpec {
  kind: SubKind;
  /** sessionId / terminalId — empty for global */
  id?: string;
}

export interface WireMsg {
  n: number;
  kind: SubKind | "meta";
  id?: string;
  [k: string]: unknown;
}

/** A wire message handed to the socket and the cursor position it reached. */
interface Ack {
  n: number;
  end: number;
}

interface ActiveSub {
  spec: Required<SubSpec>;
  /** Position of the newest accepted terminal byte offset, transcript
   *  node_id, or view version. */
  cursor: number;
  /** cursor right after subscribing — the fallback when acks can't tell */
  initial: number;
  /** recent deliveries, oldest first (bounded by ACK_CAP) */
  acks: Ack[];
  /** newest ack trimmed out of `acks` */
  floor: Ack | null;
  /** Hydration patches during a synchronous view snapshot are covered by it. */
  viewSnapshotting: boolean;
  unsub: () => void;
}

interface Connection {
  id: string;
  subs: Map<string, ActiveSub>;
  /** global messages only — the other kinds resync from their cursors */
  outbox: WireMsg[];
  n: number;
  send: ((msg: WireMsg) => boolean) | null;
  gcTimer: ReturnType<typeof setTimeout> | null;
  /** the tab's document.visibilityState, reported by the client — a
   *  backgrounded phone tab keeps its stream for a while but nobody sees it */
  visible: boolean;
}

const OUTBOX_CAP = 512;
const ACK_CAP = 1024;
/** Dead connections keep their subs (cursors) this long for reconnect replay. */
const CONN_TTL_MS = 60_000;

const connections = new Map<string, Connection>();

/** /api/health connection and subscription counts. */
export function streamStats() {
  let subs = 0;
  let live = 0;
  for (const c of connections.values()) {
    if (c.send) live++;
    subs += c.subs.size;
  }
  return { connections: connections.size, live, subs };
}

export function subKey(s: SubSpec): string {
  return `${s.kind}:${s.id ?? ""}`;
}

/** View subscriptions contribute to the session watcher count. */
function sessionOfKey(k: string): string | null {
  if (k.startsWith("view:")) return k.slice(5);
  return null;
}

function watchedSessions(c: Connection): Set<string> {
  return new Set([...c.subs.keys()].map(sessionOfKey).filter((id): id is string => id !== null));
}

function getConn(connId: string): Connection {
  let c = connections.get(connId);
  if (!c) {
    c = { id: connId, subs: new Map(), outbox: [], n: 0, send: null, gcTimer: null, visible: true };
    connections.set(connId, c);
  }
  return c;
}

/** Drop the connection (and release every sub) unless a stream re-attaches
 *  within CONN_TTL_MS. */
function armGc(c: Connection) {
  if (c.gcTimer) clearTimeout(c.gcTimer);
  c.gcTimer = setTimeout(() => {
    const sessionIds = watchedSessions(c);
    for (const sub of c.subs.values()) sub.unsub();
    connections.delete(c.id);
    for (const id of sessionIds) notifyWatchers(id);
  }, CONN_TTL_MS);
  c.gcTimer.unref?.();
}

/** Live connections viewing a session — the multi-client watcher badge. */
function sessionWatchers(id: string): number {
  let n = 0;
  for (const c of connections.values()) {
    if (c.send && c.subs.has(`view:${id}`)) n++;
  }
  return n;
}

/** Someone is looking at this session right now: a live stream, viewing
 *  it, in a visible tab. Push notifications skip sessions that are seen. */
export function sessionSeen(id: string): boolean {
  for (const c of connections.values()) {
    if (c.send && c.visible && c.subs.has(`view:${id}`)) return true;
  }
  return false;
}

/** Client-reported tab visibility (POST /api/stream/subscribe). */
export function setConnVisible(connId: string, visible: boolean) {
  const c = connections.get(connId);
  if (c) c.visible = visible;
}

/** Push the current watcher count to everyone viewing the session. */
function notifyWatchers(id: string) {
  const count = sessionWatchers(id);
  manager().view.setMeta(id, { watchers: count });
}

/** Outbound message before numbering. (Omit<WireMsg,"n"> would collapse to
 *  the index signature and lose the required `kind`.) */
type OutMsg = { kind: WireMsg["kind"]; id?: string } & Record<string, unknown>;

/** Absolute end position of a delivered wire message, per sub kind. */
function msgEnd(m: WireMsg): number | null {
  if (m.kind === "view") {
    const v = (m.view as { v?: number } | undefined)?.v;
    return typeof v === "number" && v > 0 ? v : null;
  }
  if (m.kind === "terminal") {
    if (typeof m.end === "number") return m.end;
    if (typeof m.data === "string" && typeof m.offset === "number") return m.offset;
    return null;
  }
  if (m.kind === "transcript") return typeof m.lastId === "number" ? m.lastId : null;
  return null;
}

/** Push to the live stream if connected. The sub cursor (and its ack history)
 *  only advances when the socket accepted the message. */
function deliver(c: Connection, msg: OutMsg) {
  const full: WireMsg = { ...msg, n: ++c.n };
  const sub = c.subs.get(`${full.kind}:${full.id ?? ""}`);
  if (sub && full.kind === "view" && (full.view as { t: string }).t === "snapshot") {
    // A deletion publishes v0 even while disconnected. Old ACKs/floors belong
    // to the forgotten generation and must never suppress a reused version.
    // Snapshot delivery below records its positive version only if accepted.
    sub.cursor = 0;
    sub.initial = 0;
    sub.acks = [];
    sub.floor = null;
  }
  if (full.kind === "global") {
    c.outbox.push(full);
    if (c.outbox.length > OUTBOX_CAP) c.outbox.shift();
  }
  let sent = false;
  if (c.send) {
    sent = c.send(full);
    if (!sent) {
      c.send = null; // dead stream — subs + cursors kept for reconnect
      for (const id of watchedSessions(c)) notifyWatchers(id);
    }
  }
  if (!sent) return;
  if (!sub) return;
  const end = msgEnd(full);
  if (end == null || end <= sub.cursor) return;
  sub.cursor = end;
  sub.acks.push({ n: full.n, end });
  if (sub.acks.length > ACK_CAP) sub.floor = sub.acks.shift() ?? null;
}

/** Move a sub's cursor back to the last position the client provably
 *  received (wire messages with n <= lastSeen). Resync then re-sends the rest. */
export function rewindCursor(
  sub: { cursor: number; initial: number; acks: Ack[]; floor: Ack | null },
  lastSeen: number,
) {
  let cursor = sub.floor && sub.floor.n <= lastSeen ? sub.floor.end : sub.initial;
  const kept: Ack[] = [];
  for (const a of sub.acks) {
    if (a.n > lastSeen) break;
    cursor = a.end;
    kept.push(a);
  }
  sub.acks = kept;
  sub.cursor = cursor;
}

/** Attach a new SSE stream to a connection: replay missed global messages,
 *  then rewind + resync every subscription. */
export function attachStream(
  connId: string,
  lastSeen: number,
  send: (msg: WireMsg) => boolean,
  visible = true,
): { connId: string; hadSubs: boolean } {
  const c = getConn(connId);
  c.visible = visible;
  if (c.gcTimer) {
    clearTimeout(c.gcTimer);
    c.gcTimer = null;
  }
  // a Last-Event-ID we never issued comes from another server process (the
  // browser kept it across a restart) — treat it as "nothing seen"
  const seen = lastSeen > c.n ? 0 : lastSeen;
  c.send = send;
  const hadSubs = c.subs.size > 0;
  for (const m of c.outbox) if (m.n > seen) send(m);
  for (const sub of c.subs.values()) {
    rewindCursor(sub, seen);
    resyncSub(c, sub);
  }
  for (const id of watchedSessions(c)) notifyWatchers(id);
  return { connId, hadSubs };
}

/** A superseded stream's late abort must not detach its replacement. */
export function detachStream(connId: string, send?: (msg: WireMsg) => boolean) {
  const c = connections.get(connId);
  if (!c) return;
  // deliver() can clear a failed writer before its HTTP abort arrives.
  // Protect another LIVE writer, but still collect an ownerless connection.
  if (send && c.send && c.send !== send) return;
  c.send = null;
  armGc(c);
  for (const id of watchedSessions(c)) notifyWatchers(id);
}

export function subscribe(connId: string, specs: SubSpec[]) {
  const c = getConn(connId);
  for (const spec of specs) {
    const key = subKey(spec);
    if (c.subs.has(key)) continue;
    const s: Required<SubSpec> = { kind: spec.kind, id: spec.id ?? "" };
    const sub: ActiveSub = {
      spec: s,
      cursor: 0,
      initial: 0,
      acks: [],
      floor: null,
      viewSnapshotting: false,
      unsub: () => {},
    };
    c.subs.set(key, sub);
    sub.unsub = activate(c, sub);
    resyncSub(c, sub);
    if (spec.kind === "view") notifyWatchers(s.id);
  }
  // subscriptions without a live stream must still be released eventually
  if (!c.send && !c.gcTimer) armGc(c);
}

export function unsubscribe(connId: string, specs: SubSpec[]) {
  const c = connections.get(connId);
  if (!c) return;
  for (const spec of specs) {
    const sub = c.subs.get(subKey(spec));
    if (sub) {
      sub.unsub();
      c.subs.delete(subKey(spec));
      if (spec.kind === "view") notifyWatchers(sub.spec.id);
    }
  }
}

// ---------- per-kind activation + resync ----------

function activate(c: Connection, sub: ActiveSub): () => void {
  const { kind, id } = sub.spec;
  const m = manager();
  switch (kind) {
    case "global": {
      const unsub = m.subscribeGlobal((ev) => {
        deliver(c, { kind: "global", ev });
      });
      // any tab with a global sub keeps the search index warm — db changes
      // (from the CLI or our own bridge) kick the incremental indexer
      const unsubIdx = onSessionsDbChange(scheduleCatchup);
      return () => {
        unsub();
        unsubIdx();
      };
    }
    case "view":
      return m.subscribeView(id, (view) => {
        if (!sub.viewSnapshotting) deliver(c, { kind: "view", id, view });
      });
    case "terminal": {
      const onData = (data: string, endOffset: number) => {
        deliver(c, { kind: "terminal", id, data, offset: endOffset });
      };
      const onEvent = (e: TerminalEvent) => {
        deliver(c, { kind: "terminal", id, event: e });
      };
      // host-socket reconnects surface a full/resynced snapshot through this
      // hook — it needs the reset semantic a plain data event can't express
      const unsubResync = terminalPool.onResync(id, (snap) => {
        deliver(c, {
          kind: "terminal",
          id,
          snapshot: snap.output,
          offset: snap.offset,
          end: snap.offset + Buffer.byteLength(snap.output),
          truncated: snap.truncated || snap.resynced,
          exited: snap.exited,
          partial: snap.partial,
        });
      });
      // atomic snapshot+subscribe — nothing can slip between the two. Async
      // in remote mode: the snapshot lands via this promise while live data
      // keeps flowing; the client's byte cursor dedups any overlap.
      let live = true;
      void Promise.resolve(terminalPool.attach(id, onData, onEvent, undefined, c.id))
        .then((snap) => {
          if (!live) return;
          if (!snap) {
            deliver(c, { kind: "terminal", id, event: { type: "exit", exitCode: null, signal: "unknown terminal" } });
            return;
          }
          deliver(c, {
            kind: "terminal",
            id,
            snapshot: snap.output,
            offset: snap.offset,
            end: snap.offset + Buffer.byteLength(snap.output), // client's new cursor
            truncated: snap.truncated || snap.resynced,
            exited: snap.exited,
            partial: false,
          });
        })
        .catch(() => {
          if (live) {
            deliver(c, { kind: "terminal", id, event: { type: "exit", exitCode: null, signal: "terminal host unreachable" } });
          }
        });
      return () => {
        live = false;
        unsubResync();
        void Promise.resolve(terminalPool.detach(id, onData, onEvent)).catch(() => {});
        void Promise.resolve(terminalPool.dropConnState(id, c.id)).catch(() => {});
      };
    }
    case "transcript": {
      // start at the current tip — the client already fetched the full
      // transcript via REST; pushing from 0 would resend the whole history.
      // Clamped at the durable watermark: rows of a running turn belong to
      // its provisional region and must re-scan once the freeze lifts.
      sub.cursor = Math.min(transcriptTip(id), m.durableThrough(id));
      sub.initial = sub.cursor;
      // per-sub callbacks used to each openSessionsDb() per commit —
      // subscribers now share one handle per fan-out (see fanOutTranscripts)
      const entry: TranscriptSub = { c, sub };
      transcriptSubs.add(entry);
      armTranscriptFanout();
      return () => {
        transcriptSubs.delete(entry);
        if (!transcriptSubs.size) {
          transcriptUnsub?.();
          transcriptUnsub = null;
        }
      };
    }
  }
}

/** Bring a sub up to date from its accepted cursor. */
function resyncSub(c: Connection, sub: ActiveSub) {
  const { kind, id } = sub.spec;
  if (kind === "view") {
    // Synchronous: snapshot and live patches share the same ordered wire.
    // A cursor inside the bounded log gets its tail; all others start fresh.
    const m = manager();
    const tail = sub.cursor > 0 ? m.viewSince(id, sub.cursor) : null;
    if (tail) for (const view of tail) deliver(c, { kind: "view", id, view });
    else {
      // Preparation may publish hydration patches to existing subscribers.
      // This viewer gets their final state in the snapshot; others stay live.
      sub.viewSnapshotting = true;
      let view;
      try {
        view = m.viewSnapshot(id);
      } finally {
        sub.viewSnapshotting = false;
      }
      deliver(c, { kind: "view", id, view });
    }
    return;
  }
  if (kind === "transcript") {
    pushTranscriptDelta(c, sub);
  } else if (kind === "terminal") {
    void Promise.resolve(terminalPool.snapshot(id, sub.cursor))
      .then((t) => {
      if (t && (t.output || t.resynced)) {
        deliver(c, {
          kind: "terminal",
          id,
          snapshot: t.output,
          offset: t.offset,
          end: t.offset + Buffer.byteLength(t.output),
          truncated: t.truncated || t.resynced,
          exited: t.exited,
          partial: t.partial,
        });
      }
      })
      // the host socket is down / mid-restart — the terminal sub simply
      // stays at its cursor and resyncs on the next attach. Letting this
      // reject would take the whole web process down.
      .catch(() => {});
  }
  // global: nothing to replay — clients refetch on sessions_changed
}

function transcriptTip(sessionId: string): number {
  try {
    const db = openSessionsDb();
    try {
      return maxNodeId(db, sessionId);
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/** Transcript subscriptions share one sessions.db handle per commit — a
 *  fresh openSessionsDb() per subscriber per commit measured ~55x the cost
 *  of a re-used connection on the real DB. Independent cursors and the
 *  per-session watermark are preserved: each sub still scans rows after its
 *  own cursor and clamps at its own durableThrough. */
interface TranscriptSub {
  c: Connection;
  sub: ActiveSub;
}
const transcriptSubs = new Set<TranscriptSub>();
let transcriptUnsub: (() => void) | null = null;

function armTranscriptFanout() {
  if (!transcriptUnsub) transcriptUnsub = onSessionsDbChange(fanOutTranscripts);
}

function fanOutTranscripts() {
  if (!transcriptSubs.size) return;
  let db;
  try {
    db = openSessionsDb();
  } catch {
    return; /* db busy/unreadable — next commit retries */
  }
  try {
    for (const { c, sub } of [...transcriptSubs]) {
      try {
        pushTranscriptDeltaFrom(db, c, sub);
      } catch {
        /* one bad sub must not starve the rest */
      }
    }
  } finally {
    db.close();
  }
}

function pushTranscriptDelta(c: Connection, sub: ActiveSub) {
  try {
    const db = openSessionsDb();
    try {
      pushTranscriptDeltaFrom(db, c, sub);
    } finally {
      db.close();
    }
  } catch {
    /* db busy/unreadable — next commit retries */
  }
}

function pushTranscriptDeltaFrom(
  db: ReturnType<typeof openSessionsDb>,
  c: Connection,
  sub: ActiveSub,
) {
  const id = sub.spec.id;
  const rows = nodesAfter(db, id, sub.cursor);
  if (!rows.length) return;
  // rows past the durable watermark are the running turn's — the
  // provisional region renders them. Withhold + keep the cursor so they
  // re-scan when the region drops and the watermark advances.
  const through = manager().durableThrough(id);
  const fresh: TranscriptItem[] = [];
  const idxByMsg = new Map<string, number>();
  let maxId = sub.cursor;
  for (const r of rows) {
    if (r.node_id > through) break; // rows are node_id-ordered
    // advance the cursor over every row we read — system/empty rows
    // are filtered out but still must not be re-scanned on every commit
    if (r.node_id > maxId) maxId = r.node_id;
    const it = rowToItem(r);
    if (!it) continue;
    const j = it.messageId != null ? idxByMsg.get(it.messageId) : undefined;
    if (j != null) fresh[j] = it;
    else {
      if (it.messageId != null) idxByMsg.set(it.messageId, fresh.length);
      fresh.push(it);
    }
  }
  if (!fresh.length) {
    sub.cursor = maxId; // nothing to deliver — just move past the reads
    return;
  }
  attachToolState(db, id, fresh);
  // `type: "items"` is what components/TranscriptView.tsx dispatches on
  deliver(c, { kind: "transcript", id, type: "items", items: fresh, lastId: maxId });
}

/** Test/inspection helper. */
export function connectionInfo(connId: string) {
  const c = connections.get(connId);
  return c ? { subs: [...c.subs.keys()], n: c.n, outbox: c.outbox.length } : null;
}
