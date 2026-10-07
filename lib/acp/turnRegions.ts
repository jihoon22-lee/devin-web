/** Running-turn regions and retained ephemera. External DB, persistence and
 *  event publication are injected; this class owns only region lifecycle. */
import { ItemAssembler, type AssembleEvent, type AssembledItem } from "./itemAssembler";
import { computeAnchors, type DurableSpineRow } from "./alignSpine";
import { capRetainedTurns } from "./retained";
import { noteIntegrityBeacon } from "../integrityBeacon";

export interface TurnRegionStorage {
  restore(sessionId: string): { turnId: string; startNode: number; ended: boolean; items: AssembledItem[] } | null;
  loadRetained(sessionId: string): AssembledItem[];
  save(sessionId: string, turnId: string, startNode: number, items: AssembledItem[], ended: boolean): void;
  clearExcept(sessionId: string, turnId: string): void;
  drop(sessionId: string, turnId: string): void;
  finalize(sessionId: string, turnId: string, anchors: Map<string, number>, latest?: { startNode: number; items: AssembledItem[] }): boolean | void;
  pruneRetained(sessionId: string): void;
  forget(sessionId: string): void;
}

export interface TurnRegionDeps {
  /** Durable tip, cached per sessions.db commit by the caller. */
  maxNode(sessionId: string): number;
  spineRows(sessionId: string, after: number, through: number): DurableSpineRow[];
  running(sessionId: string): boolean;
  publish(sessionId: string, regions: { provisional: AssembledItem[]; retained?: AssembledItem[]; durableThrough: number }): void;
  pokeDurable(): void;
  /** Arm the caller's shared commit subscription. */
  watchDurable(): void;
  /** Clear all cached tips on commit, or one session's tip on deletion. */
  invalidateDurable(sessionId?: string): void;
  /** Restore persisted item revisions before allocating any fresh sequence. */
  floorSeq(seq: number): void;
  nextSeq(): number;
  finalToolUpdates(sessionId: string, toolCallIds: string[]): Record<string, unknown>[];
  /** Best-effort storage: failures must not escape these operations. */
  storage: TurnRegionStorage;
}

/** session_updates that carry turn content — the only kinds allowed to
 *  lazily open a provisional region on an adopted/external turn */
const CONTENT_UPDATES = new Set([
  "user_message",
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

export class TurnRegions {
  constructor(private readonly deps: TurnRegionDeps, private readonly runId: string) {}

  // ---- two-region transcript: the provisional region is the running turn,
  // assembled server-side; durable rows must never advance into it ----
  private prov = new Map<
    string,
    { asm: ItemAssembler; turnId: string; turnStartNode: number; ended: boolean }
  >();
  private turnSeq = 0;
  private failedFinalizations = new Map<string, string>();
  /** sessions whose provisional region changed since the last flush */
  private provDirty = new Set<string>();
  /** sessions already given a one-shot itemlog restore attempt */
  private provRestored = new Set<string>();
  private provTimer: ReturnType<typeof setTimeout> | null = null;

  /** a turn region still assembling — a send-now steer uses this to tell its
   *  own unmerged turn from the one it merged into (whose region already
   *  ended on the original turn_end, so no second close must fire) */
  turnOpen(sessionId: string): boolean {
    const ps = this.prov.get(sessionId);
    return !!ps && !ps.ended;
  }

  /** sessions whose session/load is in flight — the agent replays the whole
   *  history as session/update notifications, and none of it is turn
   *  content: the durable transcript already holds it. Fed into an open
   *  region it would re-assemble every old message as part of that turn. */
  private replaying = new Set<string>();

  setReplaying(sessionId: string, on: boolean) {
    if (on) this.replaying.add(sessionId);
    else this.replaying.delete(sessionId);
  }

  /** provisional region: the current turn's assembled items */
  provisional(sessionId: string): AssembledItem[] {
    this.ensureProvisional(sessionId);
    return this.prov.get(sessionId)?.asm.list() ?? [];
  }

  /** frozen at turn start — durable must not advance past this while the
   *  turn is provisional, or mid-turn commits sink the turn's thoughts */
  turnStartNode(sessionId: string): number | null {
    this.ensureProvisional(sessionId);
    return this.prov.get(sessionId)?.turnStartNode ?? null;
  }

  /** the watermark the client renders durable rows up to. While a turn is
   *  provisional this is FROZEN at turnStartNode — rows the CLI commits
   *  mid-turn are already represented inside the provisional region; letting
   *  them into durable too would both duplicate them and sink the turn's
   *  thinking/plan items under them (symptom 2). */
  durableThrough(sessionId: string): number {
    this.ensureProvisional(sessionId);
    return this.prov.get(sessionId)?.turnStartNode ?? this.deps.maxNode(sessionId);
  }

  /** durable-covered turn ephemera (thoughts, plans) anchored to the durable
   *  row they followed — wholesale per session like every region. Loaded
   *  lazily from itemlog.db on first read (post-restart). */
  private retainedBy = new Map<string, AssembledItem[]>();
  private retainedRestored = new Set<string>();

  /** Counterpart-less items that survived their turn's flip — anchored to
   *  durable rows, never merged by text. */
  retained(sessionId: string): AssembledItem[] {
    this.ensureRetained(sessionId);
    return this.retainedBy.get(sessionId) ?? [];
  }

  private ensureRetained(sessionId: string) {
    if (this.retainedRestored.has(sessionId)) return;
    this.retainedRestored.add(sessionId);
    const items = this.deps.storage.loadRetained(sessionId);
    for (const item of items) this.deps.floorSeq(item.seqTo);
    if (items.length) this.retainedBy.set(sessionId, capRetainedTurns(items));
  }

  private noteFinalizeFailure(sid: string, turnId: string, stage: "alignment" | "storage") {
    if (this.failedFinalizations.get(sid) === turnId) return;
    this.failedFinalizations.set(sid, turnId);
    noteIntegrityBeacon("server:turnFinalizeFailed");
    console.error(`[integrity] ${sid} turnFinalizeFailed stage=${stage}`);
  }

  /** Turn flip: durable covers the ended turn. Spine items are superseded by
   *  their durable twins; counterpart-less items (thoughts, plans) are
   *  retained with anchors inside the turn's row range. A failed write keeps
   *  the provisional region for a later retry. */
  private finalizeTurn(
    sid: string,
    ps: { asm: ItemAssembler; turnId: string; turnStartNode: number },
  ) {
    let alignment: ReturnType<typeof computeAnchors>;
    try {
      const tip = this.deps.maxNode(sid);
      alignment = computeAnchors(
        ps.asm.list(),
        this.deps.spineRows(sid, ps.turnStartNode, tip),
        ps.turnStartNode,
        tip,
      );
    } catch {
      this.noteFinalizeFailure(sid, ps.turnId, "alignment");
      // Save the latest closed assembler even if alignment could not run.
      // A restart can then retry without discarding the last unflushed text.
      this.deps.storage.save(sid, ps.turnId, ps.turnStartNode, ps.asm.list(), true);
      return false;
    }
    try {
      const { anchors, violations } = alignment;
      if (violations.length) {
        noteIntegrityBeacon("server:anchorOutOfTurn");
        console.error(`[integrity] ${sid} anchorOutOfTurn ${violations.join(",")}`);
      }
      if (!anchors.size) {
        this.deps.storage.drop(sid, ps.turnId);
        this.failedFinalizations.delete(sid);
        return true;
      }
      const kept = ps.asm
        .list()
        .filter((i) => anchors.has(i.id))
        .map((i) => {
          // plan revisions live only while provisional — after the flip
          // the durable todo_write tool rows are the history
          const kept = { ...i, anchorNode: anchors.get(i.id)! };
          delete kept.revisions;
          return kept;
        });
      if (this.deps.storage.finalize(sid, ps.turnId, anchors, {
        startNode: ps.turnStartNode, items: ps.asm.list(),
      }) === false) {
        this.noteFinalizeFailure(sid, ps.turnId, "storage");
        return false;
      }
      this.failedFinalizations.delete(sid);
      this.retainedBy.set(sid, capRetainedTurns([...(this.retainedBy.get(sid) ?? []), ...kept]));
      this.deps.storage.pruneRetained(sid); // disk and memory share the same turn budget
      return true;
    } catch {
      this.noteFinalizeFailure(sid, ps.turnId, "storage");
      return false;
    }
  }

  /** sessions.db committed: an ended turn whose start is now covered by
   *  durable rows is dropped wholesale — the durable region replaces it.
   *  Counterpart-less items survive as anchored retained items. */
  onDurableChange() {
    this.deps.invalidateDurable(); // the commit is exactly what invalidates it
    let dropped = false;
    for (const [sid, ps] of this.prov) {
      if (!ps.ended) continue;
      if (this.deps.maxNode(sid) > ps.turnStartNode) {
        if (!this.finalizeTurn(sid, ps)) continue;
        this.prov.delete(sid);
        dropped = true;
        const regions = {
          provisional: [],
          retained: this.retained(sid),
          durableThrough: this.durableThrough(sid),
        };
        this.deps.publish(sid, regions);
      }
    }
    // transcript deltas withheld rows above the frozen watermark — now that
    // it advanced they are deliverable, so kick the shared watcher
    if (dropped) this.deps.pokeDurable();
  }

  /** A session adopted while its turn is running must freeze the durable
   *  watermark AT adoption — until the first content update lazily opens a
   *  region, `durableThrough` would fall back to `actualMax` and leak the
   *  turn's committed rows into durable snapshots/deltas while the region
   *  renders them too (sunkLive). ensureProvisional runs first so a web
   *  restart's itemlog restore (with its original, earlier watermark) wins
   *  over a fresh freeze. */
  adoptRunningTurn(sessionId: string) {
    this.ensureProvisional(sessionId);
    if (!this.prov.has(sessionId)) this.beginTurn(sessionId);
  }

  beginTurn(sessionId: string) {
    this.ensureProvisional(sessionId);
    const previous = this.prov.get(sessionId);
    if (previous?.ended) {
      // ACP completion does not acknowledge the independent SQLite commit.
      // Retry even without a failed write: a new turn sharing this start node
      // would erase the old ephemera and align new content to the old rows.
      this.onDurableChange();
      if (this.prov.get(sessionId) === previous && previous.asm.list().some(item =>
        item.kind === "plan" || item.kind === "tool" ||
        (item.kind === "text" && (item.role === "agent" || item.role === "thought")),
      )) {
        // Preserve the latest closed state before the coalesced flush, too.
        // Error/cancel is not proof that no later durable write can arrive.
        this.deps.storage.save(sessionId, previous.turnId, previous.turnStartNode, previous.asm.list(), true);
        return undefined;
      }
      // Empty and user-echo-only failures may never produce durable rows.
      // They have no agent content to recover and must not block the queue.
    }
    this.failedFinalizations.delete(sessionId);
    // runId makes the turn id unique across web restarts — itemlog rows are
    // keyed (session_id, item_id) and item ids embed the turn id, so a
    // reused `t1` after restart would upsert INTO the stale turn's rows
    const turnId = `t${this.runId}-${++this.turnSeq}`;
    const ps = {
      asm: new ItemAssembler(turnId),
      turnId,
      turnStartNode: this.deps.maxNode(sessionId),
      ended: false,
    };
    this.prov.set(sessionId, ps);
    this.deps.storage.clearExcept(sessionId, turnId); // a fresh turn supersedes the log
    this.deps.watchDurable();
    return ps;
  }

  /** Restart restore: re-arm the provisional region from itemlog.db the
   *  first time a session is read. A turn that ended AND whose commits
   *  already landed in sessions.db is dropped instead — durable covers it.
   *  An ended-but-not-yet-covered turn restores as ended so the next db
   *  change retires it through the normal path. */
  ensureProvisional(sessionId: string) {
    this.ensureRetained(sessionId);
    if (this.prov.has(sessionId) || this.provRestored.has(sessionId)) return;
    this.provRestored.add(sessionId);
    const r = this.deps.storage.restore(sessionId);
    if (!r || !r.items.length) return;
    for (const item of r.items) this.deps.floorSeq(item.seqTo);
    if (r.ended && this.deps.maxNode(sessionId) > r.startNode) {
      // durable already covers the closed turn — retain its thoughts/plans
      // instead of dropping (the live flip never ran while we were down)
      const asm = new ItemAssembler(r.turnId);
      asm.restore(r.items);
      if (this.finalizeTurn(sessionId, { asm, turnId: r.turnId, turnStartNode: r.startNode })) return;
    }
    const asm = new ItemAssembler(r.turnId);
    asm.restore(r.items);
    // A restarted web can lose a tool's terminal event after itemlog saved
    // its open card. The CLI db holds the final state; fold it into the
    // authoritative region so every viewer receives the same tool card.
    const open = r.items
      .filter((item) => item.kind === "tool" && item.tool && item.tool.status !== "completed" && item.tool.status !== "failed")
      .map((item) => item.tool!.toolCallId);
    for (const update of this.deps.finalToolUpdates(sessionId, open)) {
      asm.push({ seq: this.deps.nextSeq(), type: "session_update", data: update });
    }
    this.prov.set(sessionId, {
      asm,
      turnId: r.turnId,
      turnStartNode: r.startNode,
      ended: r.ended,
    });
    this.deps.watchDurable();
    this.scheduleProvFlush(sessionId);
  }

  /** Feed one emitted event into the session's provisional assembler. */
  feed(ev: AssembleEvent & { sessionId?: string }) {
    const sid = ev.sessionId;
    if (!sid || this.replaying.has(sid)) return;
    let ps = this.prov.get(sid);
    if (!ps) {
      // a region persisted before a restart re-arms here so the turn's
      // already-emitted prefix isn't lost; then a genuinely new turn starts
      this.ensureProvisional(sid);
      ps = this.prov.get(sid);
    }
    if (!ps) {
      // adopted/external turn: only real content updates imply a running
      // turn — info/config updates while idle must not freeze the watermark.
      // A client_request is turn content too: the agent can only be asking
      // while a turn is in flight.
      if (!this.deps.running(sid)) return;
      if (ev.type === "session_update") {
        const kind = (ev.data as { sessionUpdate?: unknown } | null)?.sessionUpdate;
        if (typeof kind !== "string" || !CONTENT_UPDATES.has(kind)) return;
      } else if (ev.type !== "client_request") return;
      ps = this.beginTurn(sid);
      if (!ps) return;
    }
    if (
      ev.type === "turn_end" ||
      ev.type === "turn_error" ||
      (ev.type === "notification" &&
        (ev.data as { method?: unknown } | null)?.method === "_cognition.ai/agent_stopped")
    ) {
      ps.asm.closeAll();
      ps.ended = true;
      // a turn that assembled nothing can never be covered — release the
      // watermark freeze at once instead of pinning durable forever
      if (!ps.asm.list().length) {
        this.prov.delete(sid);
        this.deps.storage.drop(sid, ps.turnId);
      }
      // the turn's durable commits may already have landed (they were
      // skipped while ended=false) — re-run the flip check now or the
      // region waits for the NEXT session's commit to retire
      this.onDurableChange();
      this.scheduleProvFlush(sid);
      return;
    }
    if (ev.type === "session_state") {
      // running:false with a live region means the turn ended while we were
      // down (or the turn_end frame was lost) — close it so durable coverage
      // can retire it through the normal drop path
      const running = (ev.data as { running?: unknown } | null)?.running;
      if (running === false && !ps.ended) {
        ps.asm.closeAll();
        ps.ended = true;
        this.onDurableChange(); // durable commits may have pre-landed
        this.scheduleProvFlush(sid);
      }
      return;
    }
    if (
      ev.type === "notification" &&
      (ev.data as { method?: unknown } | null)?.method === "_cognition.ai/thinking_complete"
    ) {
      if (ps.asm.finishRole("thought").length) this.scheduleProvFlush(sid);
      return;
    }
    if (ps.asm.push(ev).length) this.scheduleProvFlush(sid);
  }

  /** Wholesale `items` frames, coalesced to one per flush window — the
   *  region is bounded to the running turn, so replacing it whole is cheap
   *  and the client never merges two descriptions of the same content. */
  private scheduleProvFlush(sessionId: string) {
    this.provDirty.add(sessionId);
    if (this.provTimer) return;
    this.provTimer = setTimeout(() => {
      this.provTimer = null;
      for (const sid of this.provDirty) {
        const ps = this.prov.get(sid);
        // Retained changes only at a turn flip and rides snapshots, not
        // each streaming flush. An absent key preserves the client list.
        const regions = {
          provisional: ps?.asm.list() ?? [],
          durableThrough: this.durableThrough(sid),
        };
        this.deps.publish(sid, regions);
        // restart fidelity — fire-and-forget; a lost row only means the
        // region restarts emptier, never that a turn breaks
        if (ps) this.deps.storage.save(sid, ps.turnId, ps.turnStartNode, ps.asm.list(), ps.ended);
      }
      this.provDirty.clear();
    }, 40);
    this.provTimer.unref?.();
  }

  /** Session deletion also cancels its pending flush and restart state. */
  forget(sessionId: string): void {
    this.failedFinalizations.delete(sessionId);
    this.deps.invalidateDurable(sessionId);
    this.prov.delete(sessionId);
    this.provDirty.delete(sessionId);
    this.provRestored.delete(sessionId);
    this.replaying.delete(sessionId);
    this.retainedBy.delete(sessionId);
    this.retainedRestored.delete(sessionId);
    this.deps.storage.forget(sessionId);
  }
}
