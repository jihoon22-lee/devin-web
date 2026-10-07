// Server-side transcript item assembler. The agent streams chunks with no
// message identity; the CLIENT has historically re-derived item boundaries
// from role adjacency and then reconciled the result against durable rows
// by content — nine fixes, nine regressions. Here the server assembles the
// running turn into items itself, assigns stable ids (`p-<turn>-<n>`), and
// ships the region wholesale. The client stops inferring boundaries.
//
// Assembly rules are ported from the retired client-side reduceEvent
// machinery (text merge, toolCallId keying + status rank, plan snapshot
// in-place, user-echo relay consumption). Pure module: no db, no
// sockets — fully unit-testable.
import type { ContentBlock, PlanEntry, ToolCallUpdate } from "./types";

/** One recorded plan snapshot — the bounded trail that lets a restarted
 *  web show how the live plan evolved within the running turn. Provisional
 *  only: retention strips it (durable todo_write rows are the history). */
export interface PlanRevision {
  seq: number;
  ts?: number;
  entries: PlanEntry[];
}

/** Plan revisions per live item — a plan can churn every tool tick. */
export const PLAN_REVISIONS_MAX = 20;

export interface AssembledItem {
  id: string; // `p-<turnId>-<n>` — server-assigned, stable within the turn
  kind: "text" | "tool" | "plan" | "notice" | "request";
  role?: "user" | "agent" | "thought";
  text?: string;
  mentions?: { path: string; name: string }[];
  tool?: ToolCallUpdate;
  entries?: PlanEntry[];
  /** plan items only — newest snapshot last, capped at PLAN_REVISIONS_MAX */
  revisions?: PlanRevision[];
  /** agent→client request cards (permission/elicitation) — turn content,
   *  so they sit at the position they arrived, not in a trailing overlay */
  requestId?: string;
  method?: string;
  params?: Record<string, unknown>;
  resolved?: boolean;
  /** label of the picked option / outcome, e.g. "Allow once" */
  resolvedWith?: string;
  done: boolean;
  seqFrom: number;
  seqTo: number;
  /** retained items only — the durable node_id this item renders after.
   *  Set once at turn flip (see itemLogFinalize); never set while the item
   *  lives in the provisional region. */
  anchorNode?: number;
}

/** Content revision of an assembled item. Every assembler mutation bumps
 *  `seqTo` or flips done/resolved, and a retained item's anchor is set
 *  once — equal revs mean equal content, so clients can keep the object
 *  (memo) and servers can skip unchanged items in patches. */
export function itemRev(a: AssembledItem): string {
  return `${a.seqTo}|${a.done ? 1 : 0}|${a.resolved ? 1 : 0}|${a.anchorNode ?? ""}`;
}

export interface AssembleEvent {
  seq: number;
  type: string;
  data: unknown;
  ts?: number;
}

/** Same plan snapshot re-sent (reconnect replay)? Compare the fields the
 *  UI renders — a no-change update must not grow the revision trail. */
const samePlan = (a: PlanEntry[], b: PlanEntry[]): boolean =>
  a.length === b.length &&
  a.every(
    (e, i) =>
      e.content === b[i].content &&
      e.status === b[i].status &&
      e.priority === b[i].priority,
  );

const textOf = (c: ContentBlock | undefined): string => {
  if (!c) return "";
  if (c.type === "text") return typeof c.text === "string" ? c.text : "";
  if (c.type === "resource" && typeof c.resource?.text === "string") return c.resource.text;
  return "";
};

// pending < in_progress < completed|failed — max in BOTH directions; a stale
// replayed update must not undo a terminal row (AGENTS.md)
const STATUS_RANK: Record<string, number> = {
  pending: 0,
  in_progress: 1,
  completed: 2,
  failed: 2,
};

export class ItemAssembler {
  private items: AssembledItem[] = [];
  private n = 0;
  /** echo consumption state — the backend's synthetic user_message echo is
   *  relayed back by the agent as its own user_message/_chunk; identical
   *  text arriving again is the relay, not a new message */
  private pendingEcho: { text: string; pos: number } | null = null;

  constructor(private readonly turnId: string) {}

  private nextId() {
    return `p-${this.turnId}-${this.n++}`;
  }

  /** Snapshot semantics — callers may hold the array across later pushes,
   *  so never hand out the live list. Item OBJECTS are still shared (push
   *  mutates them in place): serialize promptly, don't diff a stale read. */
  list(): AssembledItem[] {
    return [...this.items];
  }

  /** restart restore: adopt persisted items wholesale; the id counter
   *  resumes past the highest persisted suffix so continued assembly
   *  can't collide with restored ids. */
  restore(items: AssembledItem[]) {
    this.items = [...items];
    for (const it of items) {
      const m = /-(\d+)$/.exec(it.id);
      if (m) this.n = Math.max(this.n, Number(m[1]) + 1);
    }
  }

  /** fold one event in; returns the items this event changed */
  push(ev: AssembleEvent): AssembledItem[] {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (ev.type === "client_request") {
      // request cards are turn content — land at the position the agent
      // asked, replayed requests update in place (reconnect re-sends pending)
      const requestId = typeof d.requestId === "string" ? d.requestId : "";
      if (!requestId) return [];
      const prev = this.items.find((i) => i.kind === "request" && i.requestId === requestId);
      if (prev) {
        prev.params = (d.params ?? {}) as Record<string, unknown>;
        prev.resolved = false;
        prev.resolvedWith = undefined;
        prev.done = false;
        prev.seqTo = ev.seq;
        return [prev];
      }
      const it: AssembledItem = {
        id: `req-${requestId}`,
        kind: "request",
        requestId,
        method: typeof d.method === "string" ? d.method : "",
        params: (d.params ?? {}) as Record<string, unknown>,
        resolved: false,
        done: false,
        seqFrom: ev.seq,
        seqTo: ev.seq,
      };
      this.items.push(it);
      return [it];
    }
    if (ev.type === "client_request_done") {
      const requestId = typeof d.requestId === "string" ? d.requestId : "";
      const prev = this.items.find((i) => i.kind === "request" && i.requestId === requestId);
      if (!prev) return [];
      prev.resolved = true;
      prev.resolvedWith = typeof d.resolvedWith === "string" ? d.resolvedWith : undefined;
      prev.done = true;
      prev.seqTo = ev.seq;
      return [prev];
    }
    if (ev.type !== "session_update") return [];
    const u = d as { sessionUpdate?: string } & Record<string, unknown>;
    switch (u.sessionUpdate) {
      case "user_message": {
        const blocks = Array.isArray(u.content) ? (u.content as ContentBlock[]) : [];
        const text = blocks
          .filter((b) => b?.type === "text")
          .map(textOf)
          .join("\n");
        const blockMentions = blocks
          .filter((b) => b?.type === "resource_link")
          .map((b) => ({
            path:
              typeof (b as { uri?: unknown }).uri === "string"
                ? (b as { uri: string }).uri.replace(/^file:\/\//, "")
                : "",
            name: typeof (b as { name?: unknown }).name === "string" ? (b as { name: string }).name : "",
          }))
          .filter((m) => m.path);
        // The manager alone knows whether an echoed prompt came from a new
        // URI-encoded request or an old queue with literal paths. Its display
        // data travels with the echo; ACP content remains untouched.
        const mentions = typeof u.echoId === "string" && Array.isArray(u.displayMentions)
          ? u.displayMentions.filter((m): m is { path: string; name: string } =>
            !!m && typeof m.path === "string" && typeof m.name === "string")
          : blockMentions;
        if (this.pendingEcho?.text === text) return []; // agent relay of our echo
        const it: AssembledItem = {
          id: this.nextId(),
          kind: "text",
          role: "user",
          text,
          mentions,
          done: true,
          seqFrom: ev.seq,
          seqTo: ev.seq,
        };
        this.items.push(it);
        this.pendingEcho = { text, pos: 0 };
        return [it];
      }
      case "user_message_chunk": {
        const t = textOf(u.content as ContentBlock);
        if (!t) return [];
        const pend = this.pendingEcho;
        if (pend) {
          const rem = pend.text.slice(pend.pos);
          if (rem.startsWith(t)) {
            pend.pos += t.length; // chunk still inside the echo — consumed
            return [];
          }
          if (t.startsWith(rem)) {
            pend.pos = pend.text.length; // echo finished — tail is new text
            return this.appendText("user", t.slice(rem.length), ev.seq);
          }
          this.pendingEcho = null; // diverged — genuinely new text
        }
        return this.appendText("user", t, ev.seq);
      }
      case "agent_message_chunk": {
        const t = textOf(u.content as ContentBlock);
        return t ? this.appendText("agent", t, ev.seq) : [];
      }
      case "agent_thought_chunk": {
        const t = textOf(u.content as ContentBlock);
        return t ? this.appendText("thought", t, ev.seq) : [];
      }
      case "tool_call":
      case "tool_call_update": {
        const tc = u as unknown as ToolCallUpdate;
        const prev = this.items.find((i) => i.kind === "tool" && i.tool?.toolCallId === tc.toolCallId);
        if (prev?.tool) {
          const status =
            (STATUS_RANK[tc.status ?? ""] ?? 0) > (STATUS_RANK[prev.tool.status ?? ""] ?? 0)
              ? tc.status
              : prev.tool.status;
          prev.tool = { ...prev.tool, ...tc, status };
          prev.seqTo = ev.seq;
          return [prev];
        }
        const it: AssembledItem = {
          id: this.nextId(),
          kind: "tool",
          tool: tc,
          done: false,
          seqFrom: ev.seq,
          seqTo: ev.seq,
        };
        this.items.push(it);
        return [it];
      }
      case "plan": {
        if (!Array.isArray(u.entries)) return [];
        const entries = u.entries as PlanEntry[];
        // the plan is a snapshot, not a message — update the latest card in
        // place so replays never stack; a stale replay must not regress it
        const prev = [...this.items].reverse().find((i) => i.kind === "plan");
        if (prev && prev.seqFrom <= ev.seq) {
          // real changes append to the bounded revision trail; a re-sent
          // identical snapshot still updates in place but earns no entry
          const basis = prev.revisions?.[prev.revisions.length - 1]?.entries ?? prev.entries ?? [];
          if (!samePlan(basis, entries)) {
            const revs = [...(prev.revisions ?? []), { seq: ev.seq, ts: ev.ts, entries }];
            prev.revisions =
              revs.length > PLAN_REVISIONS_MAX ? revs.slice(revs.length - PLAN_REVISIONS_MAX) : revs;
          }
          prev.entries = entries;
          prev.seqTo = ev.seq;
          return [prev];
        }
        if (prev) return [];
        const it: AssembledItem = {
          id: this.nextId(),
          kind: "plan",
          entries,
          revisions: [{ seq: ev.seq, ts: ev.ts, entries }],
          done: true,
          seqFrom: ev.seq,
          seqTo: ev.seq,
        };
        this.items.push(it);
        return [it];
      }
      default:
        return [];
    }
  }

  private appendText(role: "user" | "agent" | "thought", t: string, seq: number): AssembledItem[] {
    const last = this.items[this.items.length - 1];
    if (last && last.kind === "text" && last.role === role && !last.done) {
      last.text = (last.text ?? "") + t;
      last.seqTo = seq;
      return [last];
    }
    const it: AssembledItem = {
      id: this.nextId(),
      kind: "text",
      role,
      text: t,
      done: false,
      seqFrom: seq,
      seqTo: seq,
    };
    this.items.push(it);
    return [it];
  }

  /** a role boundary without a turn end — thinking_complete marks the open
   *  thought done so the next thought starts a fresh item */
  finishRole(role: "user" | "agent" | "thought"): AssembledItem[] {
    const changed: AssembledItem[] = [];
    for (const it of this.items) {
      if (it.kind === "text" && it.role === role && !it.done) {
        it.done = true;
        changed.push(it);
      }
    }
    return changed;
  }

  /** turn end — mark streaming text done; no tool card outlives its turn
   *  (a tool_call_update lost in flight must not spin forever) */
  closeAll(): AssembledItem[] {
    const changed: AssembledItem[] = [];
    for (const it of this.items) {
      if (it.kind === "text" && !it.done) {
        it.done = true;
        changed.push(it);
      } else if (it.kind === "tool" && it.tool?.status === "in_progress") {
        it.tool = { ...it.tool, status: "completed" };
        it.done = true;
        changed.push(it);
      }
    }
    return changed;
  }
}
