/** Server-authoritative session metadata and provisional transcript patches.
 * Each patch has one version; a missed version requires a fresh snapshot. */
import { emptySessionState, reduceEvent, type SessionState, type WebEvent } from "../client/model";
import { META_KEYS, PERSISTED_META_KEYS, type MetaKey, type ViewMeta } from "../client/viewMeta";
import { itemRev, type AssembledItem } from "./itemAssembler";
import type { TranscriptItem } from "../transcript";

export { META_KEYS, PERSISTED_META_KEYS } from "../client/viewMeta";
export type { MetaKey, ViewMeta } from "../client/viewMeta";

export interface ProvPatch {
  order: string[];
  upsert: AssembledItem[];
}

export type ViewFrame =
  | {
      t: "snapshot";
      v: number;
      meta: ViewMeta;
      durable: TranscriptItem[];
      durableTruncated: boolean;
      provisional: AssembledItem[];
      retained: AssembledItem[];
      durableThrough: number;
    }
  | {
      t: "patch";
      v: number;
      meta?: Partial<ViewMeta>;
      /** JSON omits undefined values, so removed optional fields travel here. */
      clearMeta?: MetaKey[];
      prov?: ProvPatch;
      retained?: AssembledItem[];
      durableThrough?: number;
    };
export type ViewPatch = Extract<ViewFrame, { t: "patch" }>;

export interface ViewStoreDeps {
  publish(sessionId: string, patch: ViewPatch): void;
  persist(sessionId: string, meta: Partial<ViewMeta>): void;
  load(sessionId: string): Partial<ViewMeta> | null;
}

const LOG_MAX = 256;
const LOG_MAX_BYTES = 1_000_000;
const PERSIST_DEBOUNCE_MS = 500;
const META_KEY_SET: ReadonlySet<string> = new Set(META_KEYS);

interface Entry {
  state: SessionState;
  v: number;
  log: { patch: ViewPatch; bytes: number }[];
  logBytes: number;
  provRevs: Map<string, string>;
  order: string[];
  retainedRevs: Map<string, string>;
  retainedOrder: string[];
  durableThrough: number | null;
  persistTimer: ReturnType<typeof setTimeout> | null;
}

type Body = Omit<ViewPatch, "t" | "v">;
type PreparedPatch = { patch: ViewPatch; published: ViewPatch; bytes: number };

function metaOf(state: SessionState): ViewMeta {
  const out: Record<string, unknown> = {};
  for (const k of META_KEYS) out[k] = state[k];
  return out as ViewMeta;
}

function sameItems(a: SessionState["items"], b: SessionState["items"]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export class SessionViewStore {
  private entries = new Map<string, Entry>();

  get size() { return this.entries.size; }

  constructor(private readonly deps: ViewStoreDeps) {}

  private entry(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      const state = emptySessionState();
      const saved = this.deps.load(sessionId);
      if (saved) {
        for (const key of PERSISTED_META_KEYS) {
          if (Object.hasOwn(saved, key)) {
            // Saved data must not be able to rewrite the live state later.
            Object.assign(state, { [key]: structuredClone(saved[key]) });
          }
        }
      }
      entry = {
        state, v: 0, log: [], logBytes: 0, provRevs: new Map(), order: [],
        retainedRevs: new Map(), retainedOrder: [], durableThrough: null, persistTimer: null,
      };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  meta(sessionId: string): ViewMeta {
    return structuredClone(metaOf(this.entry(sessionId).state));
  }

  version(sessionId: string): number {
    return this.entries.get(sessionId)?.v ?? 0;
  }

  observe(ev: WebEvent): void {
    const sid = ev.sessionId;
    if (!sid || ev.type === "items" || ev.type === "transcript_delta") return;
    const entry = this.entry(sid);
    const prev = entry.state;
    const next: SessionState = { ...prev, items: [...prev.items] };
    let state: SessionState;
    let prepared: PreparedPatch;
    let persist: boolean;
    try {
      reduceEvent(next, ev);
      const changed: Partial<ViewMeta> = {};
      const clearMeta: MetaKey[] = [];
      for (const key of META_KEYS) {
        const same = key === "items" ? sameItems(prev.items, next.items) : prev[key] === next[key];
        if (same) continue;
        if (next[key] === undefined) clearMeta.push(key);
        else Object.assign(changed, { [key]: next[key] });
      }
      if (!Object.keys(changed).length && !clearMeta.length) return;
      state = structuredClone(next);
      prepared = this.preparePatch(entry, {
        ...(Object.keys(changed).length ? { meta: changed } : {}),
        ...(clearMeta.length ? { clearMeta } : {}),
      });
      persist = PERSISTED_META_KEYS.some((key) => key in changed || clearMeta.includes(key));
    } catch {
      return; // malformed event data must not advance the view
    }
    entry.state = state;
    this.commitPatch(sid, entry, prepared);
    if (persist) this.schedulePersist(sid, entry);
  }

  setMeta(sessionId: string, meta: Partial<ViewMeta>): void {
    const entry = this.entry(sessionId);
    const changed: Record<string, unknown> = {};
    const clearMeta: MetaKey[] = [];
    for (const [key, value] of Object.entries(meta)) {
      if (!META_KEY_SET.has(key)) continue;
      if ((entry.state as unknown as Record<string, unknown>)[key] === value) continue;
      if (value === undefined) clearMeta.push(key as MetaKey);
      else changed[key] = value;
    }
    if (!Object.keys(changed).length && !clearMeta.length) return;
    const next = { ...entry.state, ...changed } as SessionState;
    for (const key of clearMeta) Object.assign(next, { [key]: undefined });
    const state = structuredClone(next);
    const prepared = this.preparePatch(entry, {
      ...(Object.keys(changed).length ? { meta: changed as Partial<ViewMeta> } : {}),
      ...(clearMeta.length ? { clearMeta } : {}),
    });
    entry.state = state;
    this.commitPatch(sessionId, entry, prepared);
    if (PERSISTED_META_KEYS.some((key) => key in changed || clearMeta.includes(key))) this.schedulePersist(sessionId, entry);
  }

  regions(
    sessionId: string,
    r: { provisional: AssembledItem[]; retained?: AssembledItem[]; durableThrough: number },
  ): void {
    const entry = this.entry(sessionId);
    const revs = new Map<string, string>();
    const upsert: AssembledItem[] = [];
    for (const item of r.provisional) {
      const rev = itemRev(item);
      revs.set(item.id, rev);
      if (entry.provRevs.get(item.id) !== rev) upsert.push(item);
    }
    const order = r.provisional.map((item) => item.id);
    const body: Body = {};
    if (upsert.length || !sameOrder(order, entry.order)) body.prov = { order, upsert };

    let nextRetainedRevs: Map<string, string> | null = null;
    let nextRetainedOrder: string[] | null = null;
    if (r.retained) {
      const retainedRevs = new Map(r.retained.map((item) => [item.id, itemRev(item)]));
      const retainedOrder = r.retained.map((item) => item.id);
      const changed = !sameOrder(retainedOrder, entry.retainedOrder) ||
        r.retained.some((item) => entry.retainedRevs.get(item.id) !== retainedRevs.get(item.id));
      if (changed) body.retained = r.retained;
      // Keep the new baseline staged until the patch is serializable.
      nextRetainedRevs = retainedRevs;
      nextRetainedOrder = retainedOrder;
    }
    if (r.durableThrough !== entry.durableThrough) body.durableThrough = r.durableThrough;
    const prepared = body.prov || body.retained || body.durableThrough !== undefined
      ? this.preparePatch(entry, body)
      : null;
    entry.provRevs = revs;
    entry.order = order;
    if (nextRetainedRevs) entry.retainedRevs = nextRetainedRevs;
    if (nextRetainedOrder) entry.retainedOrder = nextRetainedOrder;
    entry.durableThrough = r.durableThrough;
    if (prepared) this.commitPatch(sessionId, entry, prepared);
  }

  since(sessionId: string, v: number): ViewPatch[] | null {
    const entry = this.entries.get(sessionId);
    if (!entry || !Number.isInteger(v) || v < 0 || v > entry.v) return null;
    if (v === entry.v) return [];
    const first = entry.log[0]?.patch.v;
    if (first === undefined || first > v + 1) return null;
    return entry.log.filter((x) => x.patch.v > v).map((x) => structuredClone(x.patch));
  }

  forget(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry?.persistTimer) clearTimeout(entry.persistTimer);
    this.entries.delete(sessionId);
  }

  private preparePatch(entry: Entry, body: Body): PreparedPatch {
    const serialized = JSON.stringify({ t: "patch", v: entry.v + 1, ...body });
    const patch = JSON.parse(serialized) as ViewPatch;
    const bytes = Buffer.byteLength(serialized, "utf8");
    return { patch, published: structuredClone(patch), bytes };
  }

  private commitPatch(sessionId: string, entry: Entry, { patch, published, bytes }: PreparedPatch): void {
    entry.v = patch.v;
    entry.log.push({ patch, bytes });
    entry.logBytes += bytes;
    while (entry.log.length > LOG_MAX || entry.logBytes > LOG_MAX_BYTES) {
      entry.logBytes -= entry.log.shift()!.bytes;
    }
    this.deps.publish(sessionId, published);
  }

  private schedulePersist(sessionId: string, entry: Entry): void {
    if (entry.persistTimer) return;
    entry.persistTimer = setTimeout(() => {
      entry.persistTimer = null;
      const saved: Record<string, unknown> = {};
      for (const key of PERSISTED_META_KEYS) saved[key] = entry.state[key];
      this.deps.persist(sessionId, structuredClone(saved) as Partial<ViewMeta>);
    }, PERSIST_DEBOUNCE_MS);
    entry.persistTimer.unref?.();
  }
}
