// Render state receives authoritative view snapshots/patches. The shared
// event reducer supplies session metadata to the server's SessionViewStore.
//
// The transcript keeps separate durable and provisional regions:
//   durable     — persisted rows from sessions.db (bf-<nodeId> items), seeded
//                 by view snapshots and extended by transcript deltas/pages
//   provisional — the running turn, assembled SERVER-side and updated by
//                 view snapshots/patches
// `state.items` is an overlay only — request cards and notices.
import type {
  AvailableCommand,
  PlanEntry,
  SessionConfigOption,
  ToolCallUpdate,
  Usage,
} from "@/lib/acp/types";
import type { TranscriptItem } from "@/lib/transcript";
import { itemRev, type AssembledItem, type PlanRevision } from "@/lib/acp/itemAssembler";
import type { ViewFrame } from "@/lib/acp/sessionView";
import { META_KEYS } from "@/lib/client/viewMeta";

export interface WebEvent {
  seq: number;
  type: string;
  sessionId?: string;
  data: unknown;
  ts: number;
}

export type ChatItem =
  | { id: string; kind: "text"; role: "user" | "agent" | "thought"; text: string; done: boolean; mentions?: { path: string; name: string }[]; seqFrom?: number; msgId?: string; anchor?: number; ts?: number }
  | { id: string; kind: "tool"; tool: ToolCallUpdate; ts?: number; seqFrom?: number; msgId?: string; anchor?: number }
  | { id: string; kind: "plan"; entries: PlanEntry[]; revisions?: PlanRevision[]; seqFrom?: number; msgId?: string; anchor?: number }
  | { id: string; kind: "request"; requestId: string; method: string; params: Record<string, unknown>; resolved?: boolean; resolvedWith?: string; seqFrom?: number; msgId?: string; anchor?: number }
  | { id: string; kind: "notice"; text: string; seqFrom?: number; msgId?: string; anchor?: number };

export interface SessionState {
  /** View version applied; a patch must follow at exactly v + 1. */
  v?: number;
  running: boolean;
  /** ts of the session_state event that flipped running on — drives the
   *  elapsed timer in the status bar (reconnect-safe). */
  runningSince?: number;
  queued: number;
  /** previews of locally-queued prompts (sent when the turn ends) —
   *  text plus mention chips and an attachment count for ghost bubbles */
  queueItems?: { id: string; text: string; mentions?: { path: string; name: string }[]; attachments?: number }[];
  title?: string;
  modeId?: string;
  modes?: { id: string; name: string; description?: string }[];
  configOptions?: SessionConfigOption[];
  commands?: AvailableCommand[];
  usage?: { used: number; size: number; inputTokens?: number; outputTokens?: number };
  turnStats?: Record<string, unknown>;
  terminalIds: string[];
  /** overlay items only — request cards and error notices. Transcript
   *  content lives in `durable`/`provisional` */
  items: ChatItem[];
  /** the durable transcript continues above the oldest seeded bf- item —
   *  arms the "load earlier" affordance */
  historyTruncated?: boolean;
  /** live connections viewing this session — multi-client badge */
  watchers?: number;
  /** persisted transcript rows (bf-<nodeId>) up to durableThrough */
  durable?: ChatItem[];
  /** the running turn, assembled server-side — replaced wholesale by
   *  `items` frames, never merged */
  provisional?: ChatItem[];
  /** Server-assembled provisional items, kept for patching by id. */
  provisionalRaw?: AssembledItem[];
  /** durable-covered turn ephemera (thoughts, plans) pinned to the durable
   *  row they followed — rendered interleaved into `durable` by `anchor`,
   *  never in the provisional block (that's the tail-clump shape). */
  retained?: ChatItem[];
  /** durable watermark — delta rows with node_id above this belong to the
   *  running turn's provisional region and are dropped until the server
   *  advances it (they would double-render and sink thoughts beneath). */
  durableThrough?: number;
  /** durable rows present ABOVE the watermark while a provisional region
   *  is live — the one residual that strands the running turn's items below
   *  newer content in the two-region model. Correct code can never produce
   *  it (deltas are filtered, seeds are server-clamped), so any occurrence
   *  is a bug, not a heuristic hit. Counted here, beaconed by the hook,
   *  reset after each report. */
  sunkLive?: { pushed: number; inserted: number; at: number };
}

export const emptySessionState = (): SessionState => ({ running: false, queued: 0, terminalIds: [], items: [] });

/** Map durable transcript rows (GET /sessions/:id/transcript|items) onto
 *  ChatItems. Tool items keep their toolCallId so the assembled region and
 *  later delta merges key on the call, not the row. */
export function transcriptToChatItems(rows: TranscriptItem[]): ChatItem[] {
  const out: ChatItem[] = [];
  for (const r of rows) {
    if (r.role === "tool" && r.tool) {
      out.push({
        id: `bf-${r.id}`,
        kind: "tool",
        tool: r.tool as ToolCallUpdate,
        // created_at is unix seconds — the plan timeline wants epoch ms
        ts: typeof r.ts === "number" ? r.ts * 1000 : undefined,
        msgId: r.messageId,
      });
      continue;
    }
    const text = (typeof r.text === "string" ? r.text : "").trim();
    // transcript collapses non-text blocks into "[type]" placeholders — skip
    if (!text || /^\[[a-z_]+\]$/i.test(text)) continue;
    if (r.role === "tool") continue; // tool row without parsed state — skip raw json
    out.push({
      id: `bf-${r.id}`,
      kind: "text",
      role: r.role === "user" ? "user" : "agent",
      text: typeof r.text === "string" ? r.text : "",
      done: true,
      msgId: r.messageId,
      // created_at is unix seconds — message times + turn summaries
      ...(typeof r.ts === "number" ? { ts: r.ts * 1000 } : {}),
    });
  }
  return out;
}

/** Prepend an older transcript page (REST ?before=): the new bf- block goes
 *  ahead of the durable region; rows already present (page overlap) are
 *  dropped by id so a re-click can't duplicate the seam. */
export function prependTranscript(
  state: SessionState,
  rows: TranscriptItem[],
  hasMore: boolean,
  retained?: AssembledItem[],
) {
  const hist = transcriptToChatItems(rows);
  const into = state.durable ?? [];
  const have = new Set(into.map((i) => i.id));
  state.durable = [...hist.filter((i) => !have.has(i.id)), ...into];
  state.historyTruncated = hasMore;
  // page responses carry the full retained list (bounded) — union by id,
  // page items first since their anchors are older than the live tail's
  if (retained?.length) {
    const have2 = new Set((state.retained ?? []).map((i) => i.id));
    state.retained = [
      ...retained.map(retainedToChatItem).filter((i) => !have2.has(i.id)),
      ...(state.retained ?? []),
    ];
  }
}

const provToChatItem = (a: AssembledItem): ChatItem => {
  if (a.kind === "text") {
    return {
      id: a.id, kind: "text", role: a.role ?? "agent", text: a.text ?? "",
      done: a.done, mentions: a.mentions, seqFrom: a.seqFrom,
    };
  }
  if (a.kind === "tool" && a.tool) {
    return { id: a.id, kind: "tool", tool: a.tool, seqFrom: a.seqFrom };
  }
  if (a.kind === "plan") {
    return { id: a.id, kind: "plan", entries: a.entries ?? [], revisions: a.revisions, seqFrom: a.seqFrom };
  }
  if (a.kind === "request" && a.requestId) {
    return {
      id: a.id, kind: "request", requestId: a.requestId,
      method: a.method ?? "", params: a.params ?? {},
      resolved: a.resolved, resolvedWith: a.resolvedWith, seqFrom: a.seqFrom,
    };
  }
  return { id: a.id, kind: "notice", text: a.text ?? "", seqFrom: a.seqFrom };
};

/** Retained items are the same assembled shape plus a durable anchor —
 *  they render inside `durable`, not in the provisional block. */
const retainedToChatItem = (a: AssembledItem): ChatItem => ({
  ...provToChatItem(a),
  anchor: a.anchorNode,
});

/** rev of the assembled item each ChatItem was built from — kept off the
 *  ChatItem type so snapshots/tests see the same shape as before */
const revs = new WeakMap<ChatItem, string>();

/** Map a region, reusing the previous ChatItem when the assembled rev is
 *  unchanged — every frame is a fresh JSON parse, and new objects defeated
 *  memo(MessageItem): the whole running turn re-rendered every 30ms. */
function mapStable(
  prev: ChatItem[] | undefined,
  next: AssembledItem[],
  map: (a: AssembledItem) => ChatItem,
): ChatItem[] {
  const byId = new Map((prev ?? []).map((i) => [i.id, i]));
  return next.map((a) => {
    const rev = itemRev(a);
    const p = byId.get(a.id);
    if (p && revs.get(p) === rev) return p;
    const it = map(a);
    revs.set(it, rev);
    return it;
  });
}

/** Server-assembled provisional region — wholesale replacement, never a
 *  merge (the region is one bounded turn, so replacing it is cheap). The
 *  frame also carries the durable watermark. */
export function applyItemsFrame(
  state: SessionState,
  data: { provisional?: unknown; retained?: unknown; durableThrough?: unknown },
) {
  const list = Array.isArray(data.provisional) ? (data.provisional as AssembledItem[]) : [];
  state.provisionalRaw = list;
  state.provisional = mapStable(state.provisional, list, provToChatItem);
  // wholesale like every region — absent means "server too old", not empty
  if (Array.isArray(data.retained)) {
    state.retained = mapStable(state.retained, data.retained as AssembledItem[], retainedToChatItem);
  }
  if (typeof data.durableThrough === "number") {
    state.durableThrough = data.durableThrough;
    noteWatermarkViolation(state);
  }
}

/** Durable region snapshot — the REST /items response's durable side, or a
 *  view snapshot (which IS the durable tail, watermark-clamped). */
export function applyDurableSnapshot(
  state: SessionState,
  rows: TranscriptItem[],
  truncated?: boolean,
  retained?: AssembledItem[],
) {
  state.durable = transcriptToChatItems(rows);
  state.historyTruncated = truncated ?? false;
  if (retained) state.retained = retained.map(retainedToChatItem);
  noteWatermarkViolation(state);
}

/** Tripwire: durable rows with node_id above the live watermark mean the
 *  running turn's provisional items just sank beneath durable content — the
 *  two-region form of the old splice-above-live bug. `pushed` = provisional
 *  items stranded, `inserted` = offending rows, `at` = first durable index. */
function noteWatermarkViolation(state: SessionState) {
  const through = state.durableThrough;
  const prov = state.provisional?.length ?? 0;
  if (through == null || !state.durable?.length) return;
  const over = state.durable.filter((i) => Number(i.id.slice(3)) > through);
  if (!over.length) return;
  const at = state.durable.findIndex((i) => Number(i.id.slice(3)) > through);
  const prev = state.sunkLive;
  state.sunkLive = {
    pushed: (prev?.pushed ?? 0) + prov,
    inserted: (prev?.inserted ?? 0) + over.length,
    at,
  };
}

/** Newly-committed durable rows. Rows above durableThrough belong to the
 *  running turn — the provisional region already renders them, so they are
 *  dropped until the server advances the watermark. Without this, a mid-turn
 *  commit sinks the turn's thinking/plan under the durable row (symptom 2). */
export function applyDurableDelta(state: SessionState, rows: TranscriptItem[]) {
  const through = state.durableThrough;
  const vis = through != null ? rows.filter((r) => (r.id ?? 0) <= through) : rows;
  if (!vis.length) return;
  state.durable = mergeDurable(state.durable ?? [], transcriptToChatItems(vis));
  noteWatermarkViolation(state);
}

/** Apply a versioned view frame. A patch is valid only when contiguous and
 * every ordered provisional id resolves once; rejected frames leave state
 * untouched so the caller can request a fresh snapshot. */
export function applyViewFrame(state: SessionState, f: ViewFrame): "ok" | "gap" | "stale" {
  if (f.t === "snapshot") {
    const next: SessionState = { ...state };
    const defaults = emptySessionState() as unknown as Record<string, unknown>;
    const meta = f.meta as unknown as Record<string, unknown>;
    const target = next as unknown as Record<string, unknown>;
    for (const key of META_KEYS) {
      if (Object.hasOwn(meta, key)) target[key] = meta[key];
      else if (Object.hasOwn(defaults, key)) target[key] = defaults[key];
      else delete target[key];
    }
    next.items = [...next.items];
    next.terminalIds = [...next.terminalIds];
    next.durable = transcriptToChatItems(f.durable);
    next.historyTruncated = f.durableTruncated;
    next.provisionalRaw = f.provisional;
    next.provisional = mapStable(state.provisional, f.provisional, provToChatItem);
    next.retained = mapStable(state.retained, f.retained, retainedToChatItem);
    next.durableThrough = f.durableThrough;
    next.sunkLive = undefined;
    next.v = f.v;
    noteWatermarkViolation(next);
    for (const key of META_KEYS) {
      if (!Object.hasOwn(target, key)) delete (state as unknown as Record<string, unknown>)[key];
    }
    Object.assign(state, next);
    return "ok";
  }

  const have = state.v ?? 0;
  if (f.v <= have) return "stale";
  if (f.v !== have + 1) return "gap";
  let provisional = state.provisionalRaw ?? [];
  if (f.prov) {
    const byId = new Map(provisional.map((item) => [item.id, item]));
    for (const item of f.prov.upsert) byId.set(item.id, item);
    const seen = new Set<string>();
    const ordered: AssembledItem[] = [];
    for (const id of f.prov.order) {
      const item = byId.get(id);
      if (!item || seen.has(id)) return "gap";
      seen.add(id);
      ordered.push(item);
    }
    provisional = ordered;
  }

  const next: SessionState = { ...state };
  const target = next as unknown as Record<string, unknown>;
  const defaults = emptySessionState() as unknown as Record<string, unknown>;
  for (const key of f.clearMeta ?? []) {
    if (Object.hasOwn(defaults, key)) target[key] = defaults[key];
    else delete target[key];
  }
  if (f.meta) {
    Object.assign(next, f.meta);
    if (f.meta.items) next.items = [...f.meta.items];
  }
  if (f.prov || f.retained || f.durableThrough != null) {
    applyItemsFrame(next, {
      provisional,
      ...(f.retained ? { retained: f.retained } : {}),
      ...(f.durableThrough != null ? { durableThrough: f.durableThrough } : {}),
    });
  }
  next.v = f.v;
  for (const key of f.clearMeta ?? []) {
    if (!Object.hasOwn(target, key)) delete (state as unknown as Record<string, unknown>)[key];
  }
  Object.assign(state, next);
  return "ok";
}

/** id/msgId merge for durable rows — same-message recommits update in place.
 *  No live-item absorption: provisional content lives in its own region. */
function mergeDurable(into: ChatItem[], fresh: ChatItem[]): ChatItem[] {
  const byId = new Set(into.map((i) => i.id));
  const byMsg = new Map<string, number>();
  into.forEach((it, i) => {
    if (it.msgId) byMsg.set(it.msgId, i);
  });
  const out = [...into];
  for (const it of fresh) {
    if (byId.has(it.id)) continue;
    if (it.msgId != null) {
      const prev = byMsg.get(it.msgId);
      if (prev !== undefined) {
        out[prev] = it;
        byId.add(it.id);
        continue;
      }
    }
    byId.add(it.id);
    out.push(it);
  }
  return out;
}

/** Turn boundary — request cards live inside the provisional region at the
 *  spot they were asked; when the turn ends the region retires, so drop the
 *  resolved overlay copies too or they'd resurface piled at the tail.
 *  Unanswered requests stay — still answerable. */
function settleRequests(state: SessionState) {
  if (state.items.some((i) => i.kind === "request" && i.resolved)) {
    state.items = state.items.filter((i) => i.kind !== "request" || !i.resolved);
  }
}

/** Notices live in the items overlay — rendered at the tail — so without a
 *  lifecycle they would sit at the bottom of the session forever. Two rules
 *  keep them bounded: identical text replaces its stale copy instead of
 *  stacking, and at most NOTICE_MAX stick around at once. A third rule lives
 *  in the session_state case: starting a new turn retires all notices. */
const NOTICE_MAX = 5;

function pushNotice(state: SessionState, text: string, seq: number) {
  state.items = state.items.filter((i) => i.kind !== "notice" || i.text !== text);
  state.items.push({ id: `ev-${seq}`, kind: "notice", text, seqFrom: seq });
  let excess = 0;
  for (const i of state.items) if (i.kind === "notice") excess++;
  excess -= NOTICE_MAX;
  if (excess > 0) {
    state.items = state.items.filter((i) => {
      if (i.kind === "notice" && excess > 0) {
        excess--;
        return false;
      }
      return true;
    });
  }
}

/** Interleave retained items into the durable list: each renders right
 *  before the first rendered row with node_id > anchor (its anchor row's
 *  successor). anchor == the last rendered row lands on the tail seam.
 *  An anchor above the window belongs to content past it — skip. An anchor
 *  BELOW the window belongs to an earlier page: skip when one exists
 *  (historyTruncated — it renders when that page loads), else pin to the
 *  window top (nothing above is loadable, so top is least-wrong). Order
 *  within one anchor = list order. */
const numId = (i: ChatItem) => Number(i.id.slice(3)) || 0;

function interleaveRetained(
  durable: ChatItem[],
  retained: ChatItem[],
  historyTruncated: boolean,
): ChatItem[] {
  if (!durable.length) return durable;
  const sorted = [...retained]
    .filter((i) => i.anchor != null)
    .sort((a, b) => a.anchor! - b.anchor!);
  if (!sorted.length) return durable;
  const out: ChatItem[] = [];
  let prev = historyTruncated ? numId(durable[0]) : -Infinity;
  let k = 0;
  for (const row of durable) {
    const id = numId(row);
    while (k < sorted.length && sorted[k].anchor! < id) {
      if (sorted[k].anchor! >= prev) out.push(sorted[k]);
      k++;
    }
    out.push(row);
    prev = id;
  }
  while (k < sorted.length && sorted[k].anchor! <= prev) out.push(sorted[k++]);
  return out;
}

/** What the transcript renders: durable (with retained interleaved by
 *  anchor) ++ provisional ++ overlay items (request cards, notices — not
 *  transcript content). The overlay is a fallback: requests the provisional
 *  region already carries are dropped here so the card renders at its
 *  assembled position, not twice. */
export function renderItems(state: SessionState): ChatItem[] {
  const prov = state.provisional ?? [];
  const durable = state.retained?.length
    ? interleaveRetained(state.durable ?? [], state.retained, !!state.historyTruncated)
    : (state.durable ?? []);
  if (!state.items.length) return [...durable, ...prov];
  const inProv = new Set(prov.map((i) => i.id));
  return [
    ...durable,
    ...prov,
    ...state.items.filter((i) => !inProv.has(i.id)),
  ];
}

/** Fold one event into session state (mutates the draft's arrays in place but
 *  never mutates an existing item — changed items get a new object identity).
 *  Turn content is NOT assembled here — session_update text/tool/plan kinds
 *  belong to the server's provisional region and are ignored. */
export function reduceEvent(state: SessionState, ev: WebEvent) {
  // ev.data may legitimately be null (synthesized turn_end carries no
  // payload) — treat it as {} so every case below can read fields safely
  const d = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "session_update": {
      const u = d as { sessionUpdate?: string } & Record<string, unknown>;
      const kind = u.sessionUpdate;
      if (kind === "current_mode_update") {
        if (typeof u.currentModeId === "string") state.modeId = u.currentModeId;
        if (Array.isArray(u.availableModes)) {
          state.modes = u.availableModes as SessionState["modes"];
        }
      } else if (kind === "config_option_update") {
        if (Array.isArray(u.configOptions)) {
          state.configOptions = u.configOptions as SessionConfigOption[];
        }
      } else if (kind === "available_commands_update") {
        if (Array.isArray(u.availableCommands)) {
          state.commands = u.availableCommands as AvailableCommand[];
        }
      } else if (kind === "session_info_update") {
        if (typeof u.title === "string") state.title = u.title;
      } else if (kind === "usage_update") {
        const meta = (u._meta ?? {}) as Record<string, number>;
        state.usage = {
          used: typeof u.used === "number" ? u.used : 0,
          size: typeof u.size === "number" ? u.size : 0,
          inputTokens: meta["cognition.ai/inputTokens"],
          outputTokens: meta["cognition.ai/outputTokens"],
        };
      }
      // content kinds (user_message*, *_message_chunk, agent_thought_chunk,
      // tool_call*, plan) belong to the provisional region — ignored here
      break;
    }
    case "client_request": {
      const { requestId, method } = d as { requestId: string; method: string };
      const params = (d.params ?? {}) as Record<string, unknown>;
      // pending requests are re-sent on every (re)connect — update in place
      const idx = state.items.findIndex(
        (i) => i.kind === "request" && i.requestId === requestId,
      );
      const prev = idx >= 0 ? state.items[idx] : null;
      if (prev && prev.kind === "request") {
        state.items[idx] = { ...prev, params, resolved: false, resolvedWith: undefined };
      } else {
        state.items.push({
          id: `req-${requestId}`,
          kind: "request",
          requestId,
          method,
          params,
        });
      }
      break;
    }
    case "client_request_done": {
      const { requestId, resolvedWith } = d as { requestId: string; resolvedWith?: string };
      const idx = state.items.findIndex(
        (i) => i.kind === "request" && i.requestId === requestId,
      );
      const prev = idx >= 0 ? state.items[idx] : null;
      if (prev && prev.kind === "request") {
        state.items[idx] = { ...prev, resolved: true, resolvedWith };
      }
      break;
    }
    case "session_state": {
      const was = state.running;
      // only apply fields the event actually carries — a bare {detached}
      // marker must not zero out the queue display, but it does mean the
      // turn can't be running on the new agent process
      if ("running" in d || d.detached) {
        state.running = d.detached ? false : !!d.running;
        if (state.running && !was) {
          state.runningSince = ev.ts;
          // a new turn retires the previous turn's notices — the same rule
          // as settled request cards; a repeated failure re-adds fresh
          if (state.items.some((i) => i.kind === "notice")) {
            state.items = state.items.filter((i) => i.kind !== "notice");
          }
        } else if (!state.running) {
          state.runningSince = undefined;
          if (was) settleRequests(state);
        }
      }
      if ("queued" in d) {
        state.queued = typeof d.queued === "number" && Number.isFinite(d.queued) ? d.queued : 0;
        if (state.queued === 0) state.queueItems = [];
      }
      if (Array.isArray(d.queue)) {
        state.queueItems = (d.queue as { id?: unknown; text?: unknown; mentions?: unknown; attachments?: unknown }[]).map(
          (q) => ({
            id: typeof q?.id === "string" ? q.id : "",
            text: typeof q?.text === "string" ? q.text : "",
            mentions: Array.isArray(q?.mentions)
              ? q.mentions
                  .map((m) => {
                    const mm = m as { path?: unknown; name?: unknown };
                    return {
                      path: typeof mm?.path === "string" ? mm.path : "",
                      name: typeof mm?.name === "string" ? mm.name : "",
                    };
                  })
                  .filter((m) => m.path)
              : undefined,
            attachments: typeof q?.attachments === "number" && q.attachments > 0 ? q.attachments : undefined,
          }),
        );
      }
      break;
    }
    case "turn_end": {
      state.running = false;
      state.runningSince = undefined;
      settleRequests(state);
      const usage = (d as { usage?: Usage }).usage;
      if (usage) {
        state.usage = {
          used: state.usage?.used ?? usage.totalTokens ?? 0,
          size: state.usage?.size ?? 0,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        };
      }
      break;
    }
    case "turn_error": {
      state.running = false;
      state.runningSince = undefined;
      settleRequests(state);
      pushNotice(
        state,
        `Error: ${(d as { message?: string }).message ?? "unknown"}`,
        ev.seq,
      );
      break;
    }
    case "notice": {
      // lightweight one-off overlay — unlike turn_error it must NOT touch
      // running state (a failed send-now lands while the turn still runs)
      const text = (d as { text?: unknown }).text;
      if (typeof text === "string" && text) pushNotice(state, text, ev.seq);
      break;
    }
    case "notice_dismiss": {
      const id = (d as { id?: unknown }).id;
      if (typeof id === "string") {
        state.items = state.items.filter((i) => !(i.kind === "notice" && i.id === id));
      }
      break;
    }
    case "notification": {
      const { method } = d as { method: string };
      const params = (d.params ?? {}) as Record<string, unknown>;
      if (method === "_cognition.ai/agent_stopped") {
        state.running = false;
        state.runningSince = undefined;
        settleRequests(state);
        state.turnStats = params.stats as Record<string, unknown> | undefined;
      } else if (method === "_devin-web/terminal_created") {
        const tid = params.terminalId;
        if (typeof tid === "string" && tid && !state.terminalIds.includes(tid)) {
          state.terminalIds = [...state.terminalIds, tid];
        }
      }
      break;
    }
    case "watchers": {
      // server-side connection census — seq:0 meta event, not a chat event
      const { count } = d as { count?: number };
      if (typeof count === "number") state.watchers = count;
      break;
    }
    default:
      break;
  }
}
