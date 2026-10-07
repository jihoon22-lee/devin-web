import { watch } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { emptySessionState, reduceEvent } from "../client/model";
import { SessionViewStore, type ViewFrame, type ViewMeta, type ViewPatch } from "./sessionView";
import { AcpBridge, type ClientRequestEvent } from "./bridge";
import { PendingRequests, type PendingClientRequest } from "./pendingRequests";
import { hostClient } from "./terminal";
import { DEVIN_CLI_DIR, LockedSessionError, lockOwner } from "../locks";
import { type AssembledItem } from "./itemAssembler";
import { pickCoveringStep } from "./forkSteps";
import { pushForEvent } from "../push";
import { blocksBytes, displayMentions, queueView } from "./queuePreview";
import { displayTitle } from "../client/display";
import { type DurableSpineRow } from "./alignSpine";
import { TurnRegions } from "./turnRegions";
import { itemLogClearExcept, itemLogDrop, itemLogFinalize, itemLogForget, itemLogLoadRetained, itemLogPruneRetained, itemLogRestore, itemLogSave, itemLogSaveMeta, itemLogLoadMeta } from "../itemLog";
import { maxNodeId, nodesAfter, openSessionsDb } from "../db";
import { onSessionsDbChange, pokeSessionsDb } from "../transcriptWatch";
import { readTranscriptItems, finalToolUpdates } from "../transcript-db";
import { rowToItem } from "../transcript";
import { readAllQueues, writeSessionQueue } from "../promptQueue";
import type { QueuedPrompt } from "../promptQueue";
import type { TranscriptItem } from "../transcript";
import type {
  ContentBlock,
  InitializeResult,
  NewSessionResult,
  RevertStepInfo,
  SessionInfoEntry,
  SessionNotification,
} from "./types";
import { METHODS } from "./types";
import { mentionPath } from "./mentionUri";
import { QUEUE_MAX_BYTES } from "../limits";

export interface WebEvent {
  seq: number;
  type: string;
  sessionId?: string;
  data: unknown;
  ts: number;
}

export type { PendingClientRequest } from "./pendingRequests";

interface ActiveSession {
  sessionId: string;
  cwd: string;
  running: boolean;
  /** deleteSession ran while a runPrompt still held this object — its
   *  finally must not drain the queue into (or emit for) a dead session */
  deleted?: boolean;
  /** Hold queued work until the delete RPC succeeds or fails. */
  deleting?: boolean;
  /** user wants this session attached */
  loaded: boolean;
  /** bridge generation it was loaded into — stale after an acp restart */
  attachedGen: number;
  queue: QueuedPrompt[];
  /** taken over mid-turn from the daemon — no session/load replay will ever
   *  arrive, so resyncing clients are seeded from the durable transcript */
  adopted?: boolean;
  /** a runPrompt in THIS process owns the current turn. The daemon appends a
   *  synthesized turn_end to every prompt response (same tick) — while this is
   *  set that notification is ignored so the queue shifts exactly once (in
   *  runPrompt's finally), never twice */
  ownsTurn?: boolean;
  /** send-now steered prompts still in flight. A merged steer resolves with
   *  its turn; an unmerged one runs its own turn no runPrompt owns — keep
   *  `running` held until the last one settles so mid-steer updates still
   *  feed a region and prompts keep queueing instead of racing it. */
  steerInFlight?: number;
  /** a daemon-synthesized turn_end arrived while a steer was in flight — the
   *  signal is real (a turn did end) but can't clear running yet; the steer's
   *  settle consumes it to decide whether anything may still be live */
  steerSawTurnEnd?: boolean;
  /** auto-reattach is suppressed until this time after a failed attempt */
  reattachAfter?: number;
  /** last reattach error — surfaced via listSessions as attachFailed */
  attachError?: string;
}

interface SessionListEntry extends SessionInfoEntry {
  isLocked?: boolean;
  active?: boolean;
  running?: boolean;
  /** wanted attached but the last auto-reattach failed (locked elsewhere…) */
  attachFailed?: boolean;
}

/** Adopted-session transcript seed size — recent context, not full history. */
const BACKFILL_TAIL = 50;

/** Event types worth pushing to the global SSE — per-session traffic
 *  (session_update chunks etc.) stays on the per-session stream. */
const GLOBAL_TYPES = new Set(["sessions_changed", "agent_exit", "session_state"]);
/** Min delay between auto-reattach attempts for a session that failed once. */
const REATTACH_BACKOFF_MS = 30_000;
/** session/load replays the whole transcript — large histories can far
 *  exceed the default 30s request ceiling */
const SESSION_LOAD_TIMEOUT_MS = 120_000;

export class SessionManager {
  readonly bridge: AcpBridge;
  initResult: InitializeResult | null = null;
  private starting: Promise<InitializeResult> | null = null;

  private sessions = new Map<string, ActiveSession>();
  private viewSubs = new Map<string, Set<(f: ViewFrame) => void>>();
  private pendingViews: { sessionId: string; frame: ViewFrame }[] = [];
  private publishingView = false;
  /** Server-authoritative metadata and region baselines. */
  readonly view = new SessionViewStore({
    publish: (sid, patch) => this.publishView(sid, patch),
    persist: (sid, meta) => itemLogSaveMeta(sid, meta),
    load: (sid) => itemLogLoadMeta(sid) as Partial<ViewMeta> | null,
  });

  private publishView(sessionId: string, frame: ViewFrame) {
    this.pendingViews.push({ sessionId, frame });
    if (this.publishingView) return;
    this.publishingView = true;
    try {
      // A failed stream updates watchers while its callback is still running.
      // Finish the current broadcast before any resulting newer version, so
      // every healthy viewer sees the same version order and records valid ACKs.
      while (this.pendingViews.length) {
        const next = this.pendingViews.shift()!;
        for (const fn of this.viewSubs.get(next.sessionId) ?? []) {
          try {
            fn(next.frame);
          } catch (error) {
            console.error("[view] subscriber failed", error);
          }
        }
      }
    } finally {
      this.publishingView = false;
    }
  }

  subscribeView(sessionId: string, fn: (f: ViewFrame) => void): () => void {
    // Establish the baseline before registering a fresh consumer: hydration
    // must not send it patches ahead of its initial snapshot. No durable read.
    this.prepareView(sessionId);
    let set = this.viewSubs.get(sessionId);
    if (!set) this.viewSubs.set(sessionId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size && this.viewSubs.get(sessionId) === set) this.viewSubs.delete(sessionId);
    };
  }

  /** Reconcile runtime truth and current (possibly not yet flushed) regions.
   * Capture the version only AFTER this: seeding can publish real changes. */
  private prepareView(sessionId: string) {
    const meta = this.view.meta(sessionId);
    const next = { ...emptySessionState(), ...meta };
    reduceEvent(next, { seq: 0, type: "session_state", sessionId,
      data: this.queueState(sessionId), ts: Date.now() });
    const pending = new Map(this.pendingFor(sessionId).map((r) => [r.requestId, r]));
    // Keep notices and resolved cards. An unanswered overlay must correspond
    // to an actual request; adopted requests may not have emitted here yet.
    next.items = next.items.map((item) => item.kind === "request" && !item.resolved && !pending.has(item.requestId)
      ? { ...item, resolved: true } : item);
    for (const request of pending.values()) {
      const index = next.items.findIndex((item) => item.kind === "request" && item.requestId === request.requestId);
      const prev = next.items[index];
      if (prev?.kind === "request" && !prev.resolved && prev.method === request.method && isDeepStrictEqual(prev.params, request.params)) continue;
      const item = { id: `req-${request.requestId}`, kind: "request" as const,
        requestId: request.requestId, method: request.method, params: request.params };
      if (index < 0) next.items.push(item);
      else next.items[index] = item;
    }
    const changed: Partial<ViewMeta> = {};
    for (const key of ["running", "runningSince", "queued", "queueItems", "items"] as const) {
      // The empty queue's absent default and [] are the same runtime truth.
      if (key === "queueItems" && !meta.queueItems && !next.queueItems?.length) continue;
      if (!isDeepStrictEqual(meta[key], next[key])) Object.assign(changed, { [key]: next[key] });
    }
    this.view.setMeta(sessionId, changed);
    const regions = {
      provisional: this.provisional(sessionId),
      retained: this.retained(sessionId),
      durableThrough: this.durableThrough(sessionId),
    };
    this.view.regions(sessionId, regions);
    return regions;
  }

  /** Both durable rows and region state use this one synchronous watermark. */
  viewSnapshot(sessionId: string): Extract<ViewFrame, { t: "snapshot" }> {
    const regions = this.prepareView(sessionId);
    const seed = this.transcriptSeed(sessionId, regions.durableThrough);
    return structuredClone({
      t: "snapshot", v: this.view.version(sessionId), meta: this.view.meta(sessionId),
      durable: seed.items, durableTruncated: seed.truncated, ...regions,
    });
  }

  viewSince(sessionId: string, v: number): ViewPatch[] | null {
    return this.view.since(sessionId, v);
  }

  private globalSubs = new Set<(e: WebEvent) => void>();
  private pending = new PendingRequests({
    emit: (sessionId, type, data) => this.emit(sessionId, type, data),
    changed: () => this.broadcastGlobal({ type: "sessions_changed", data: {} }),
  });
  /** the raw map — kept addressable for tests that seed requests directly */
  private get pendingRequests() {
    return this.pending.map;
  }
  private queueSeq = 0;
  /** per-boot tag on q-/d- ids — a restart resets queueSeq, and without this
   *  the mirror can replay an old `echo-d-1` or queue `q-1` that collides
   *  with a fresh prompt's id (dedup would eat the real echo). */
  private runId = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  private readonly regions = new TurnRegions({
    maxNode: (sid) => this.actualMax(sid),
    spineRows: (sid, after, through) => this.durableSpineRows(sid, after, through),
    running: (sid) => this.sessions.get(sid)?.running ?? false,
    publish: (sid, regions) => this.view.regions(sid, regions),
    pokeDurable: pokeSessionsDb,
    watchDurable: () => this.hookDbChange(),
    invalidateDurable: (sid) => {
      if (sid === undefined) this.maxNodeCache.clear();
      else this.maxNodeCache.delete(sid);
    },
    floorSeq: (seq) => { this.seq = Math.max(this.seq, seq); },
    nextSeq: () => this.nextSeq(),
    finalToolUpdates,
    storage: {
      restore: itemLogRestore,
      loadRetained: itemLogLoadRetained,
      save: itemLogSave,
      clearExcept: itemLogClearExcept,
      drop: itemLogDrop,
      finalize: itemLogFinalize,
      pruneRetained: itemLogPruneRetained,
      forget: itemLogForget,
    },
  }, this.runId);

  provisional(sessionId: string): AssembledItem[] {
    return this.regions.provisional(sessionId);
  }

  retained(sessionId: string): AssembledItem[] {
    return this.regions.retained(sessionId);
  }

  turnStartNode(sessionId: string): number | null {
    return this.regions.turnStartNode(sessionId);
  }

  durableThrough(sessionId: string): number {
    return this.regions.durableThrough(sessionId);
  }

  private dbSub: (() => void) | null = null;
  /** test seam — pretend the durable db advanced to a node_id */
  private testDurable = new Map<string, number>();

  /** Memoized per sessions.db commit. `durableThrough` sits on request and
   *  push paths (every transcript delta, every provisional flush, the /items
   *  route), and a fresh DatabaseSync per call both leaked the handle — only
   *  GC finalization closed it — and cost ~55x a reused one on the real
   *  1.1GB db. The shared commit notifier is the exact invalidation signal;
   *  a stale-low value can only withhold rows, which the delta cursor
   *  re-scans on the next commit, so the cache can never over-report. */
  private maxNodeCache = new Map<string, { n: number; at: number }>();
  /** Backstop for a missed commit notification. The watcher is layered
   *  (fs.watch + a WAL stat-poll + the daemon's push), but an on-demand
   *  reader like the /items route must never serve an indefinitely stale
   *  watermark if all three miss. */
  private static readonly MAX_NODE_TTL_MS = 1_000;

  private actualMax(sessionId: string): number {
    const t = this.testDurable.get(sessionId);
    if (t != null) return t;
    const now = Date.now();
    const hit = this.maxNodeCache.get(sessionId);
    if (hit && now - hit.at < SessionManager.MAX_NODE_TTL_MS) return hit.n;
    this.hookDbChange(); // arms the invalidation this cache depends on
    let n = 0;
    try {
      const db = openSessionsDb();
      try {
        n = maxNodeId(db, sessionId);
      } finally {
        db.close();
      }
    } catch {
      return 0; // db missing/locked — don't cache a failure
    }
    this.maxNodeCache.set(sessionId, { n, at: now });
    return n;
  }

  /** test-only: pretend the durable db advanced, then run the drop check the
   *  real sessions.db watcher would trigger. Production never calls this. */
  __testDurableThrough(sessionId: string, n: number) {
    this.testDurable.set(sessionId, n);
    this.regions.onDurableChange();
  }

  private hookDbChange() {
    if (this.dbSub) return;
    this.dbSub = onSessionsDbChange(() => this.regions.onDurableChange());
  }

  /** The turn's durable rows in node order, reduced to alignment inputs.
   *  rowToItem applies the same display filters the client render uses, so
   *  anchors only ever point at rows that actually render. */
  private durableSpineRows(
    sessionId: string,
    after: number,
    through: number,
  ): DurableSpineRow[] {
    try {
      const db = openSessionsDb();
      try {
        return nodesAfter(db, sessionId, after)
          .filter((r) => r.node_id <= through)
          .map((r) => rowToItem(r))
          .filter((i): i is NonNullable<typeof i> => i != null)
          .map((i) => ({
            nodeId: Number(i.id),
            role: i.role === "user" ? "user" : i.role === "tool" ? "tool" : "agent",
            toolCallId: i.toolCallId,
          }));
      } finally {
        db.close();
      }
    } catch {
      // db missing/locked — coverage was already proven by actualMax, so
      // empty alignment just anchors everything to the turn's start
      return [];
    }
  }

  private seq = 0;
  /** increments every time the acp process exits — loaded sessions become stale */
  private generation = 0;
  /** cwd overrides chosen by the user for brand-new sessions. */
  defaultCwd = process.cwd();

  constructor() {
    this.bridge = new AcpBridge({
      onSessionUpdate: (n) => this.onSessionUpdate(n),
      onNotification: (m, p) => this.onNotification(m, p),
      onClientRequest: (ev) => this.onClientRequest(ev),
      // fs requests with relative paths resolve against the SESSION's cwd,
      // not this process's cwd — the web server runs from the devin-web repo,
      // so resolving there lands another project's artifacts in this tree
      // (the b9-*.png pollution).
      sessionCwd: (sid) => this.sessions.get(sid)?.cwd,
      onExit: (code, signal) => {
        this.broadcastGlobal({ type: "agent_exit", data: { code, signal } });
        this.generation++;
        // a turn this process owns ends through runPrompt's rejection; an
        // adopted one has no pending prompt, so nothing else would tell its
        // viewers (or its still-open region) that the turn is gone
        for (const s of this.sessions.values()) {
          const wasAdoptedTurn = s.running && !s.ownsTurn;
          s.running = false;
          if (wasAdoptedTurn && !s.deleted) this.emit(s.sessionId, "session_state", { running: false });
        }
        // The agent is gone — pending permission/elicitation cards can never be
        // answered now. Reject them so the UI dismisses the cards instead of
        // leaving them stuck across the restart.
        this.pending.rejectAll(-32603, "devin acp exited");
        // lazy restart on next ensure(); stale sessions re-attach in reattachStale()
      },
    });
  }

  /** PID of the underlying `devin acp` process, for lock attribution. */
  get bridgePid(): number | null {
    return this.bridge.pid;
  }

  /** After an acp restart, re-issue session/load for everything the user
   *  still wants attached (loaded && attachedGen !== generation). Failures
   *  back off per session (reattachAfter) instead of retrying every ensure();
   *  sessions_changed is broadcast only when an attach state actually moved. */
  private async reattachStale() {
    const now = Date.now();
    const stale = [...this.sessions.values()].filter(
      (s) =>
        !s.deleting &&
        s.loaded &&
        s.attachedGen !== this.generation &&
        (s.reattachAfter ?? 0) <= now,
    );
    // daemon mode: acp survived the web restart and still holds sessions. A
    // BUSY one must be adopted, never re-loaded — session/load on a live
    // session kills its in-flight turn (T0 spike). Idle ones take the normal
    // load path so history replays; anything absent from the daemon's list
    // (the agent itself restarted) loads normally too.
    const ds = this.bridge.socketMode ? await this.bridge.daemonState() : null;
    const daemonBusy = new Map(
      (ds?.sessions ?? []).filter((s) => s.busy).map((s) => [s.sessionId, s]),
    );
    let changed = false;
    // mid-turn sessions the web never knew about (fresh process, empty map):
    // adopt them too so the sidebar shows them running instead of dormant
    for (const d of daemonBusy.values()) {
      if (this.sessions.has(d.sessionId)) continue;
      this.sessions.set(d.sessionId, {
        sessionId: d.sessionId,
        cwd: d.cwd ?? this.defaultCwd,
        running: true,
        loaded: true,
        attachedGen: this.generation,
        queue: this.hydrateQueue(d.sessionId),
        adopted: true,
      });
      this.regions.adoptRunningTurn(d.sessionId);
      this.emitCaps(d.sessionId, d.loadResult);
      this.emit(d.sessionId, "session_state", { adopted: true, running: true });
      changed = true;
    }
    if (!stale.length) {
      if (changed) this.broadcastGlobal({ type: "sessions_changed", data: {} });
      return;
    }
    // parallel — ensure() awaits this, so serial loads would stack each
    // session's worst-case timeout onto every API call behind it
    await Promise.all(
      stale.map(async (s) => {
        const d = daemonBusy.get(s.sessionId);
        if (d) {
          const cur = this.sessions.get(s.sessionId);
          if (cur) {
            cur.attachedGen = this.generation;
            cur.running = true;
            cur.adopted = true;
            cur.reattachAfter = undefined;
            cur.attachError = undefined;
          }
          this.regions.adoptRunningTurn(s.sessionId);
          this.emitCaps(s.sessionId, d.loadResult);
          this.emit(s.sessionId, "session_state", { adopted: true, running: true });
          changed = true;
          return;
        }
        try {
          const res = await this.requestLoad(s.sessionId, s.cwd);
          const cur = this.sessions.get(s.sessionId);
          if (cur) {
            cur.attachedGen = this.generation;
            cur.reattachAfter = undefined;
            cur.attachError = undefined;
          }
          this.emitCaps(s.sessionId, res);
          changed = true;
        } catch (e) {
          // session may be locked elsewhere — mark it detached and back off so
          // a failing reattach can't loop on every ensure() call
          const cur = this.sessions.get(s.sessionId);
          if (cur) {
            cur.reattachAfter = Date.now() + REATTACH_BACKOFF_MS;
            cur.attachError = (e as Error).message;
          }
          this.emit(s.sessionId, "session_state", { detached: true });
          changed = true; // attachFailed flag flipped → list should refresh once
        }
      }),
    );
    if (changed) this.broadcastGlobal({ type: "sessions_changed", data: {} });
    // An acp restart clears `running` mid-queue — without this the parked
    // prompts would sit dormant until the user typed again. Only drain
    // sessions actually attached to the CURRENT generation (backoff and
    // adopted-busy ones skip: running=true / stale attachedGen).
    for (const s of this.sessions.values()) {
      if (s.deleting || s.running || !s.queue.length || s.attachedGen !== this.generation) continue;
      const next = s.queue.shift();
      if (next) {
        this.persistQueue(s);
        this.launchPrompt(s, next.blocks, next.id, next.mentionEncoding);
      }
    }
  }

  private dbWatcherStarted = false;

  /** fs.watch on sessions.db* → broadcast sessions_changed so activity in
   *  external CLI processes (new sessions, updatedAt bumps) appears without polling. */
  private startDbWatch() {
    if (this.dbWatcherStarted) return;
    this.dbWatcherStarted = true;
    try {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const w = watch(DEVIN_CLI_DIR, (_e, fname) => {
        if (!fname?.startsWith("sessions.db")) return;
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          this.broadcastGlobal({ type: "sessions_changed", data: {} });
        }, 600);
      });
      w.unref?.();
    } catch {
      /* fs.watch unsupported — clients fall back to polling */
    }
  }

  async ensure(): Promise<InitializeResult> {
    this.startDbWatch();
    // Keep terminal and database-change pushes connected before the first RPC.
    hostClient()?.warmup?.();
    if (!this.starting) {
      this.starting = this.bridge
        .ensure()
        // await reattach before resolving: a prompt issued right after an acp
        // restart must not run before its session is re-loaded into the new
        // process (it would fail with "not loaded").
        .then(async (r) => {
          this.initResult = r;
          await this.reattachStale();
          return r;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  // ---------- event bus ----------

  private nextSeq(): number {
    return ++this.seq;
  }

  /** "is a visible tab showing this session?" — wired to the stream layer
   *  by lib/state.ts (importing it here would be a module cycle). Until
   *  then every session counts as unseen. */
  pushSeen: (sessionId: string) => boolean = () => false;

  private emit(sessionId: string | undefined, type: string, data: unknown) {
    // Restore both regions before allocating the first event sequence. Their
    // persisted seqTo drives item revisions and retained/live display order,
    // independently of the daemon or any browser's view version.
    if (sessionId) this.regions.ensureProvisional(sessionId);
    const ev: WebEvent = { seq: this.nextSeq(), type, sessionId, data, ts: Date.now() };
    if (sessionId) {
      this.regions.feed(ev);
      this.view.observe(ev);
      try {
        pushForEvent(ev, {
          title: (sid) => displayTitle(this.view.meta(sid).title, "devin-web"),
          seen: (sid) => this.pushSeen(sid),
        });
      } catch (e) {
        console.error(`[push] ${(e as Error).message}`);
      }
    }
    if (GLOBAL_TYPES.has(type)) for (const fn of this.globalSubs) fn(ev);
  }

  private broadcastGlobal(ev: { type: string; data: unknown }) {
    const e: WebEvent = { seq: this.nextSeq(), type: ev.type, data: ev.data, ts: Date.now() };
    for (const fn of this.globalSubs) fn(e);
  }

  subscribeGlobal(fn: (e: WebEvent) => void): () => void {
    this.globalSubs.add(fn);
    return () => this.globalSubs.delete(fn);
  }

  /** Bounded durable tail for a fresh view snapshot. */
  transcriptSeed(sessionId: string, watermark?: number): {
    items: TranscriptItem[];
    truncated: boolean;
    retained: AssembledItem[];
  } {
    // The seed IS the durable region — while a turn is provisional it
    // reads at the frozen watermark (`through` resolves the chain tip
    // at-or-below it), or mid-turn commits would fill the tail window and
    // double-render inside both regions. Read errors must reach the caller's
    // retry path: a successful empty snapshot would erase displayed history.
    const through = watermark ?? this.durableThrough(sessionId);
    return {
      ...readTranscriptItems(sessionId, { tail: BACKFILL_TAIL, through }),
      retained: this.retained(sessionId),
    };
  }

  pendingFor(sessionId?: string): PendingClientRequest[] {
    return this.pending.forSession(sessionId);
  }

  // ---------- agent → client requests (browser-answered) ----------

  private onClientRequest(ev: ClientRequestEvent) {
    this.pending.add(ev);
  }

  // `sessionId` binds the request to the session URL it arrived under —
  // without it a caller could answer ANOTHER session's pending permission
  // card through its own session's route.
  respondToRequest(requestId: string, result: unknown, sessionId?: string): boolean {
    return this.pending.respond(requestId, result, sessionId);
  }

  /** Dismiss an overlay notice — server-authoritative so every connected
   *  view drops it together. Only `kind:"notice"` items are dismissible. */
  dismissNotice(sessionId: string, itemId: string): boolean {
    const hit = this.view
      .meta(sessionId)
      .items?.find((i) => i.kind === "notice" && i.id === itemId);
    if (!hit) return false;
    this.emit(sessionId, "notice_dismiss", { id: itemId });
    return true;
  }

  cancelRequest(requestId: string, sessionId?: string): boolean {
    return this.pending.cancel(requestId, sessionId);
  }

  // ---------- notifications ----------

  private onSessionUpdate(n: SessionNotification) {
    this.emit(n.sessionId, "session_update", n.update);
    const u = n.update as { sessionUpdate?: string; title?: string };
    // title/updatedAt live in the sidebar — any info update warrants a
    // sessions refetch, not just ones carrying a new title
    if (u.sessionUpdate === "session_info_update") {
      this.broadcastGlobal({ type: "sessions_changed", data: {} });
    }
  }

  private onNotification(method: string, params: unknown) {
    const p = params as { sessionId?: string } | undefined;
    // daemon-synthesized turn end: a prompt issued before a web restart has no
    // pending request here to resolve — this is how an adopted session's
    // running state clears when the turn actually finishes
    if (method === "_devin-web/turn_end" && p?.sessionId) {
      const s = this.sessions.get(p.sessionId);
      // the daemon piggybacks this on our own prompt's response — a locally
      // owned turn's lifecycle belongs to runPrompt's finally; handling the
      // notification too would shift the queue twice and run prompts in
      // parallel
      if (s?.running && !s.ownsTurn) {
        if (s.steerInFlight) {
          // a steer can be running its own turn — the daemon also piggybacks
          // turn_end on the ORIGINAL prompt's response, so this signal must
          // not clear running yet; the steer's settle decides instead
          s.steerSawTurnEnd = true;
          return;
        }
        s.running = false;
        this.emit(p.sessionId, "turn_end", {});
        this.broadcastGlobal({ type: "sessions_changed", data: {} });
        const next = s.deleting ? undefined : s.queue.shift();
        if (next) this.persistQueue(s);
        this.emit(p.sessionId, "session_state", {
          running: false,
          queued: s.queue.length,
          queue: queueView(s),
        });
        if (next) this.launchPrompt(s, next.blocks, next.id, next.mentionEncoding);
      }
      return;
    }
    // Keep shim signals visible to global subscribers for logging/UX.
    // Session-scoped signals also update the authoritative view metadata.
    if (method.startsWith("_devin-web/")) {
      if (p?.sessionId) this.emit(p.sessionId, "notification", { method, params });
      this.broadcastGlobal({ type: "notification", data: { method, params } });
      return;
    }
    this.emit(p?.sessionId || undefined, "notification", { method, params });
  }

  // ---------- session ops ----------

  async listSessions(cwd?: string): Promise<SessionListEntry[]> {
    await this.ensure();
    const res = (await this.bridge.request(METHODS.sessionList, cwd ? { cwd } : {})) as {
      sessions: SessionInfoEntry[];
      nextCursor?: string | null;
    };
    // Phase 2-3: the daemon's busy tracking is the durable truth — after a
    // web restart this process hasn't re-adopted sessions yet, but the
    // daemon still knows which turns are in flight
    const daemonBusy = new Set<string>();
    const h = hostClient();
    if (h?.available) {
      try {
        for (const s of await h.sessionsState()) if (s.busy) daemonBusy.add(s.sessionId);
      } catch {
        /* host mid-restart — local attach state still applies */
      }
    }
    return (res.sessions ?? []).map((s) => {
      const a = this.sessions.get(s.sessionId);
      return {
        ...s,
        isLocked: !!(s._meta as Record<string, unknown> | undefined)?.["cognition.ai/isLocked"],
        active: a?.loaded === true && a.attachedGen === this.generation,
        running: a?.running === true || daemonBusy.has(s.sessionId),
        attachFailed:
          a?.loaded === true &&
          a.attachedGen !== this.generation &&
          a.attachError !== undefined,
      };
    });
  }

  async createSession(cwd: string): Promise<NewSessionResult> {
    await this.ensure();
    const res = (await this.bridge.request(METHODS.sessionNew, {
      cwd,
      mcpServers: [],
    })) as NewSessionResult;
    this.sessions.set(res.sessionId, {
      sessionId: res.sessionId,
      cwd,
      running: false,
      loaded: true,
      attachedGen: this.generation,
      queue: [],
    });
    this.emitCaps(res.sessionId, res);
    this.broadcastGlobal({ type: "sessions_changed", data: {} });
    return res;
  }

  /** Forward modes/configOptions from new/load/fork responses into the session's event stream. */
  private emitCaps(sessionId: string, res: NewSessionResult | unknown) {
    const r = res as {
      modes?: { currentModeId?: string; availableModes?: unknown[] };
      configOptions?: unknown[];
    };
    if (r?.modes) {
      this.emit(sessionId, "session_update", {
        sessionUpdate: "current_mode_update",
        currentModeId: r.modes.currentModeId,
        availableModes: r.modes.availableModes,
      });
    }
    if (r?.configOptions) {
      this.emit(sessionId, "session_update", {
        sessionUpdate: "config_option_update",
        configOptions: r.configOptions,
      });
    }
  }

  /** session/load for a session with no running turn — both callers rule
   *  out a busy daemon session first, and a fresh agent runs nothing. A
   *  region still open here is stale (its turn_end was lost across a web
   *  restart or an agent exit): close it, then keep the history replay out
   *  of the regions — fed into an open region it re-assembles every old
   *  message as part of that turn (the 2026-10-03/04 integrity dupes). */
  private async requestLoad(sessionId: string, cwd: string): Promise<unknown> {
    this.regions.ensureProvisional(sessionId);
    if (this.regions.turnOpen(sessionId)) this.emit(sessionId, "session_state", { running: false });
    this.regions.setReplaying(sessionId, true);
    try {
      return await this.bridge.request(
        METHODS.sessionLoad,
        { sessionId, cwd, mcpServers: [] },
        { timeoutMs: SESSION_LOAD_TIMEOUT_MS },
      );
    } finally {
      this.regions.setReplaying(sessionId, false);
    }
  }

  /** in-flight session/load per sessionId — two tabs opening the same session
   *  must share one request; issuing session/load twice can hit a turn that
   *  started between them */
  private loads = new Map<string, Promise<unknown>>();

  async loadSession(sessionId: string, cwd: string): Promise<unknown> {
    await this.ensure();
    const existing = this.sessions.get(sessionId);
    if (existing?.deleting) throw new Error(`session ${sessionId} is being deleted`);
    if (existing?.loaded && existing.attachedGen === this.generation) {
      return { sessionId, alreadyLoaded: true };
    }
    const inflight = this.loads.get(sessionId);
    if (inflight) return inflight;
    const p = this.doLoadSession(sessionId, cwd, existing)
      .finally(() => this.loads.delete(sessionId));
    this.loads.set(sessionId, p);
    return p;
  }

  private async doLoadSession(
    sessionId: string,
    cwd: string,
    existing: ActiveSession | undefined,
  ): Promise<unknown> {
    if (!existing) {
      this.sessions.set(sessionId, {
        sessionId,
        cwd,
        running: false,
        loaded: false,
        attachedGen: -1,
        queue: this.hydrateQueue(sessionId),
      });
    }
    // daemon mode: a BUSY session still lives inside the surviving acp — adopt
    // it in place. Re-issuing session/load would kill the in-flight turn.
    const ds = this.bridge.socketMode ? await this.bridge.daemonState() : null;
    const d = ds?.sessions?.find((x) => x.sessionId === sessionId && x.busy);
    if (d) {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.loaded = true;
        s.attachedGen = this.generation;
        s.running = true;
        s.adopted = true;
        s.reattachAfter = undefined;
        s.attachError = undefined;
      }
      this.regions.adoptRunningTurn(sessionId);
      this.emitCaps(sessionId, d.loadResult);
      this.emit(sessionId, "session_state", { adopted: true, running: true });
      this.broadcastGlobal({ type: "sessions_changed", data: {} });
      return { sessionId, adopted: true };
    }
    let res: unknown;
    try {
      res = await this.requestLoad(sessionId, cwd);
    } catch (e) {
      // roll back the placeholder — a failed load must not mark the session active
      if (!existing) {
        this.sessions.delete(sessionId);
          }
      throw e;
    }
    const s = this.sessions.get(sessionId);
    if (s) {
      s.loaded = true;
      s.attachedGen = this.generation;
    }
    this.emitCaps(sessionId, res);
    this.broadcastGlobal({ type: "sessions_changed", data: {} });
    // a queue restored from disk on a session that turns out idle still means
    // "send when the turn ends" — that turn ended with the restart, so drain
    // now rather than parking forever
    if (s && !s.deleting && !s.running && s.queue.length) {
      const next = s.queue.shift();
      if (next) {
        this.persistQueue(s);
        this.launchPrompt(s, next.blocks, next.id, next.mentionEncoding);
      }
    }
    return res;
  }

  async deleteSession(sessionId: string) {
    await this.ensure();
    // Refuse while a live foreign process holds the session lock — deleting
    // under a running devin CLI/TUI pulls its session.db rows out from under
    // it. Take over first (which kills/clears the holder), then delete.
    let ourPid = this.bridgePid;
    if (ourPid == null && this.bridge.socketMode) {
      ourPid = (await this.bridge.daemonState().catch(() => null))?.acpPid ?? null;
    }
    const owner = lockOwner(sessionId, ourPid);
    if (owner?.alive && !owner.ours) throw new LockedSessionError(sessionId, owner);
    const s = this.sessions.get(sessionId);
    if (s?.deleting) throw new Error(`session ${sessionId} is being deleted`);
    if (s) s.deleting = true;
    let res: unknown;
    try {
      res = await this.bridge.request(METHODS.sessionDelete, { sessionId });
    } catch (error) {
      if (s) {
        s.deleting = false;
        // The turn may have ended while deletion was in flight. A refused
        // delete leaves the session and its original queue usable.
        if (!s.running && !s.deleted && s.queue.length && this.sessions.get(sessionId) === s) {
          this.afterTurn(s);
        }
      }
      throw error;
    }
    // a deleted session's pending permission/elicitation cards can never be
    // answered meaningfully — reject them so the UI doesn't leave ghosts
    for (const pr of this.pendingFor(sessionId)) {
      pr.respondError(-32603, "session deleted");
    }
    if (s) {
      // a runPrompt awaiting its response still holds this object
      s.deleted = true;
      s.queue.length = 0;
    }
    this.sessions.delete(sessionId);
    this.view.forget(sessionId);
    this.regions.forget(sessionId);
    writeSessionQueue(sessionId, []); // a deleted session's queue dies with it
    // Existing consumers must reset their version cursor before this id can
    // be reused. Construct the empty snapshot without recreating a store entry.
    this.publishView(sessionId, {
      t: "snapshot", v: 0, meta: emptySessionState(), durable: [],
      durableTruncated: false, provisional: [], retained: [], durableThrough: 0,
    });
    this.broadcastGlobal({ type: "sessions_changed", data: {} });
    return res;
  }

  getSession(sessionId: string): ActiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  // ---------- prompting (with queueing) ----------

  async prompt(sessionId: string, blocks: ContentBlock[]): Promise<{ queued: boolean }> {
    await this.ensure();
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`session ${sessionId} is not loaded`);
    if (s.deleting) throw new Error(`session ${sessionId} is being deleted`);
    // a session whose reattach failed (locked elsewhere / backed off) must
    // fail fast here — a prompt into a generation that never loaded it
    // surfaces only as an opaque turn_error otherwise
    if (s.attachedGen !== this.generation) {
      throw new Error(s.attachError ?? `session ${sessionId} is not attached to the current agent`);
    }
    if (s.running) {
      // a stuck turn must not let the queue grow without bound — the user
      // gets an explicit error instead of a silent memory pile
      if (s.queue.length >= 50) throw new Error("prompt queue is full (50)");
      // same bound on bytes: image/audio payloads live inline in blocks, so
      // count alone can't stop a queue from pinning hundreds of MB
      if (s.queue.reduce((n, q) => n + blocksBytes(q.blocks), 0) + blocksBytes(blocks) > QUEUE_MAX_BYTES)
        throw new Error(`prompt queue is full (${Math.round(QUEUE_MAX_BYTES / 1048576)}MB)`);
      const q: QueuedPrompt = { id: `q-${this.runId}-${++this.queueSeq}`, blocks, mentionEncoding: "uri" };
      s.queue.push(q);
      this.persistQueue(s);
      // no echo here — queued prompts render as ghost bubbles derived from
      // queueItems, so edit/drop can retract them cleanly; the real bubble
      // lands when runPrompt drains this entry (echoId = q.id).
      this.emit(sessionId, "session_state", {
        running: true,
        queued: s.queue.length,
        queue: queueView(s),
      });
      return { queued: true };
    }
    this.launchPrompt(s, blocks, undefined, "uri");
    return { queued: false };
  }

  /** Every detached runPrompt call goes through here so an escaped rejection
   *  can never wedge the queue. runPrompt's own try/finally settles the turn;
   *  this catch is the last-resort guard for a throw outside that scope. */
  private launchPrompt(s: ActiveSession, blocks: ContentBlock[], echoId?: string, mentionEncoding?: "uri") {
    void this.runPrompt(s, blocks, echoId, mentionEncoding).catch((e) => {
      console.error(`[manager] runPrompt escaped rejection for ${s.sessionId}:`, e);
      if (s.ownsTurn) {
        s.running = false;
        s.ownsTurn = false;
        if (!s.deleted) this.emit(s.sessionId, "turn_error", { message: (e as Error).message });
        if (!s.deleted) this.afterTurn(s);
      }
    });
  }

  private async runPrompt(s: ActiveSession, blocks: ContentBlock[], echoId?: string, mentionEncoding?: "uri") {
    try {
      s.running = true;
      s.ownsTurn = true;
      // the turn IS the provisional boundary — a fresh assembler + a durable
      // watermark frozen at this instant. The echo below is the turn's first
      // item and lands inside the region.
      this.regions.beginTurn(s.sessionId);
      this.emit(s.sessionId, "session_state", {
        running: true,
        queued: s.queue.length,
        queue: queueView(s),
      });
      this.emit(s.sessionId, "session_update", {
        sessionUpdate: "user_message",
        content: blocks,
        displayMentions: displayMentions(blocks, mentionEncoding),
        echoId: echoId ?? `d-${this.runId}-${++this.queueSeq}`,
      });
      const res = await this.bridge.request(
        METHODS.sessionPrompt,
        { sessionId: s.sessionId, prompt: blocks },
        { timeoutMs: 0 }, // a turn can legitimately run for hours — no ceiling
      );
      if (!s.deleted) this.emit(s.sessionId, "turn_end", res ?? {});
    } catch (e) {
      if (!s.deleted) this.emit(s.sessionId, "turn_error", { message: (e as Error).message });
    } finally {
      // a send-now steer may be running a turn this process never owned —
      // hold running until the last steer settles; its settle re-enters
      // here through afterTurn
      s.running = (s.steerInFlight ?? 0) > 0;
      s.ownsTurn = false;
      if (!s.deleted) this.afterTurn(s);
    }
  }

  /** Queue drain + state stamp after a locally owned turn. */
  private afterTurn(s: ActiveSession) {
    // the agent died under this turn: onExit bumped the generation before
    // this continuation ran. The queue belongs to the NEXT generation —
    // shifting here would fire every parked prompt at a dead bridge (one
    // instant turn_error each, content lost). reattachStale drains it after
    // the session is re-loaded.
    // while a steer is in flight the turn may not actually be over —
    // draining now would fire parked prompts into it instead of after it
    const next = !s.deleting && !s.steerInFlight && s.attachedGen === this.generation
      ? s.queue.shift()
      : undefined;
    if (next) this.persistQueue(s);
    this.emit(s.sessionId, "session_state", {
      running: s.running,
      queued: s.queue.length,
      queue: queueView(s),
    });
    // the transcript just gained nodes — refresh the sidebar's updatedAt
    this.broadcastGlobal({ type: "sessions_changed", data: {} });
    if (next) this.launchPrompt(s, next.blocks, next.id, next.mentionEncoding);
  }

  cancel(sessionId: string, opts?: { clearQueue?: boolean }) {
    this.bridge.notify(METHODS.sessionCancel, { sessionId });
    // A cancelled turn can leave its permission/elicitation requests dangling —
    // answer them `cancelled` so the cards resolve instead of waiting forever.
    for (const pr of this.pendingFor(sessionId)) this.cancelRequest(pr.requestId);
    const s = this.sessions.get(sessionId);
    if (s && opts?.clearQueue && s.queue.length) {
      s.queue.length = 0;
      this.persistQueue(s);
      this.emit(sessionId, "session_state", {
        running: s.running,
        queued: 0,
        queue: [],
      });
    }
  }

  /** Send-now: pull a parked prompt and inject it into the live turn. The
   *  agent accepts a mid-turn session/prompt — it answers at the next tool
   *  boundary and logs the message as its own user node (verified on the
   *  wire), so this steers without interrupting the running tool call.
   *  Nothing running → the entry just drains as a normal prompt. */
  sendQueuedNow(sessionId: string, id: string): { sent: boolean } | null {
    const s = this.sessions.get(sessionId);
    const index = s ? s.queue.findIndex((q) => q.id === id) : -1;
    if (!s || index < 0) return null;
    if (s.deleted || s.deleting) return { sent: false };
    const [item] = s.queue.splice(index, 1);
    // mirror the removal before the send attempt — a restart between splice
    // and the agent's response must not resurrect an already-sent prompt
    this.persistQueue(s);
    if (s.running && s.attachedGen === this.generation) {
      s.steerInFlight = (s.steerInFlight ?? 0) + 1;
      this.emit(sessionId, "session_state", {
        running: true,
        queued: s.queue.length,
        queue: queueView(s),
      });
      // the agent never relays a steered message — echo it locally like
      // runPrompt does so the real bubble swaps the queue ghost at once
      this.emit(sessionId, "session_update", {
        sessionUpdate: "user_message",
        content: item.blocks,
        displayMentions: displayMentions(item.blocks, item.mentionEncoding),
        echoId: item.id,
      });
      let resolved = false;
      void this.bridge
        .request(METHODS.sessionPrompt, { sessionId, prompt: item.blocks }, { timeoutMs: 0 })
        .then((res) => {
          resolved = true;
          // an unmerged steer ran a turn of its own — close it like a
          // runPrompt response would. Skip while a runPrompt turn is still
          // live (its own response closes it) or the region already ended
          // (a merged steer's turn_end already fired) — turnOpen separates
          // the two.
          if (!s.ownsTurn && !s.deleted && this.regions.turnOpen(sessionId))
            this.emit(sessionId, "turn_end", res ?? {});
        })
        .catch(() => {
          // never reached the agent — put the entry back where it was
          s.queue.splice(Math.min(index, s.queue.length), 0, item);
          if (!s.deleted) {
            this.persistQueue(s);
            this.emit(sessionId, "session_state", {
              running: s.running,
              queued: s.queue.length,
              queue: queueView(s),
            });
            this.emit(sessionId, "notice", {
              text: "Send-now failed — the prompt was returned to the queue",
            });
          }
        })
        .finally(() => {
          s.steerInFlight = (s.steerInFlight ?? 1) - 1;
          if (s.steerInFlight || s.ownsTurn || s.deleted || !s.running) return;
          // resolved: the steered turn is over, drop the held flag. rejected:
          // the steer never ran — drop only if a real turn end was deferred
          // while steering; otherwise an adopted turn may still be live and
          // the daemon's own turn_end will land to clear it.
          if (resolved || s.steerSawTurnEnd) {
            s.steerSawTurnEnd = false;
            s.running = false;
            this.afterTurn(s);
          }
        });
      return { sent: true };
    }
    if (s.attachedGen === this.generation) {
      // idle session — send-now is just a drain (queue was parked by a dead
      // generation or a stale view)
      this.emit(sessionId, "session_state", {
        running: s.running,
        queued: s.queue.length,
        queue: queueView(s),
      });
      this.launchPrompt(s, item.blocks, item.id, item.mentionEncoding);
      return { sent: true };
    }
    // dead bridge generation — park the entry again rather than dropping it
    s.queue.splice(Math.min(index, s.queue.length), 0, item);
    this.persistQueue(s);
    return { sent: false };
  }

  /** Remove one queued prompt by id; returns editable blocks so the client
   *  can restore text, images and literal mention paths into the input. */
  dequeue(sessionId: string, id: string): { blocks: ContentBlock[] } | null {
    const s = this.sessions.get(sessionId);
    const index = s ? s.queue.findIndex((q) => q.id === id) : -1;
    if (!s || index < 0) return null;
    const [item] = s.queue.splice(index, 1);
    this.persistQueue(s);
    this.emit(sessionId, "session_state", {
      running: s.running,
      queued: s.queue.length,
      queue: queueView(s),
    });
    // The existing composer restore protocol strips file:// literally.
    // Adapt encoded links only at this boundary; stored/drained ACP blocks
    // keep their proper URIs, and old raw queue links remain untouched.
    const blocks = item.mentionEncoding === "uri"
      ? item.blocks.map((b) => b.type === "resource_link"
        ? { ...b, uri: `file://${mentionPath(b.uri)}` }
        : b)
      : item.blocks;
    return { blocks };
  }

  /** The queue is durable (lib/promptQueue) — every mutation mirrors to disk
   *  so a web restart delivers parked prompts late instead of dropping them
   *  while the daemon mirror replays a stale `queued:1` ghost. */
  private persistQueue(s: ActiveSession) {
    writeSessionQueue(s.sessionId, s.queue);
  }

  /** Queue a restarted web may still have on file but not yet attached. */
  private hydrateQueue(sessionId: string): QueuedPrompt[] {
    return readAllQueues()[sessionId] ?? [];
  }

  /** Authoritative queue/running state for view hydration. */
  queueState(sessionId: string) {
    const s = this.sessions.get(sessionId);
    const queue = s?.queue ?? this.hydrateQueue(sessionId);
    return {
      running: s?.running === true,
      queued: queue.length,
      queue: queueView({ queue }),
    };
  }

  /** Rename through the CLI's instant `/rename` command. (devin acp exposes
   *  no rename method — probing one only cost a -32601 round-trip.) */
  renameSession(sessionId: string, title: string) {
    // strip newlines — the title is inlined into a prompt line, so a \n in
    // the name would smuggle extra prompt text into the command
    const clean = title.replace(/[\r\n]+/g, " ").trim();
    if (!clean) return Promise.reject(new Error("empty title"));
    return this.prompt(sessionId, [{ type: "text", text: `/rename ${clean}` }]);
  }

  /** Share through the CLI's instant `/share` command; the link is posted
   *  into the conversation. Queued if a turn is running. */
  shareSession(sessionId: string) {
    return this.prompt(sessionId, [{ type: "text", text: "/share" }]);
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean) {
    await this.ensure();
    const res = await this.bridge.request(METHODS.sessionSetConfigOption, {
      sessionId,
      configId,
      value,
    });
    // the response carries the updated configOptions — push it into the event
    // stream so the UI reflects the change without a reload
    this.emitCaps(sessionId, res);
    return res;
  }

  async setMode(sessionId: string, modeId: string) {
    await this.ensure();
    const res = await this.bridge.request(METHODS.sessionSetMode, { sessionId, modeId });
    this.emitCaps(sessionId, res);
    return res;
  }

  /** True when the agent echoed cognition.ai/revert in agentCapabilities._meta —
   *  the client advertised it at initialize and the agent enabled the
   *  _cognition.ai/revert/* surface (listSteps / forkFromStep). A cached
   *  daemon init from before the flag existed reports false until the agent
   *  is re-initialized (acpd restart). */
  get supportsRevert(): boolean {
    const meta = this.initResult?.agentCapabilities?._meta;
    return meta?.["cognition.ai/revert"] === true;
  }

  /** Fork the session at the history step covering `nodeId` — the
   *  cognition.ai/revert surface clones up to that step's
   *  forkTargetNodeId (the CLI's `/fork [step]` semantics, node-accurate).
   *  Steps are the protocol's granularity: a mid-step click forks the whole
   *  containing step. */
  async forkAtNode(sessionId: string, cwd: string, nodeId: number) {
    await this.ensure();
    if (!this.supportsRevert) {
      throw new Error(
        "fork-at-node needs the revert extension — this agent session never echoed cognition.ai/revert (restart the ACP daemon)",
      );
    }
    const list = (await this.bridge.request(METHODS.revertListSteps, { sessionId })) as {
      steps?: RevertStepInfo[];
    };
    const covering = pickCoveringStep(list?.steps ?? [], nodeId);
    if (!covering) {
      throw new Error("no forkable step covers that node — the session has no prompt steps yet");
    }
    const res = (await this.bridge.request(METHODS.revertForkFromStep, {
      sessionId,
      targetNodeId: covering.forkTargetNodeId,
    })) as { forkedSessionId?: string; sessionId?: string };
    const newId = res?.forkedSessionId ?? res?.sessionId;
    if (!newId) throw new Error("forkFromStep returned no session id");
    // forkFromStep creates but does not attach — load it so the UI opens a
    // live session, same as session/fork's result
    await this.loadSession(newId, cwd);
    return { sessionId: newId };
  }

  async fork(sessionId: string, cwd: string) {
    await this.ensure();
    const res = (await this.bridge.request(METHODS.sessionFork, {
      sessionId,
      cwd,
      mcpServers: [],
    })) as NewSessionResult;
    if (res?.sessionId) {
      this.sessions.set(res.sessionId, {
        sessionId: res.sessionId,
        cwd,
        running: false,
        loaded: true,
        attachedGen: this.generation,
        queue: [],
      });
      this.emitCaps(res.sessionId, res);
      this.broadcastGlobal({ type: "sessions_changed", data: {} });
    }
    return res;
  }
}

export type { SessionListEntry as SessionEntry };
