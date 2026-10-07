/** Provisional-item log — persists the running turn's assembled region so a
 *  web restart mid-turn restores it (thoughts especially: they never reach
 *  sessions.db, so without this a restart erases the visible thinking).
 *  Lives in `$STATE_DIR/itemlog.db`; fully rebuildable — a lost log just
 *  means the provisional region restarts empty, like the pre-P3 behavior.
 *
 *  `turns` records each region's frozen watermark (`start_node`) and whether
 *  the turn ended — restore drops a turn whose end is already covered by
 *  durable rows, keeps one whose commits haven't landed yet.
 *
 *  Same cache-db pattern as treeIndex: openDb + WAL/NORMAL, `broken` latch
 *  on open failure so a corrupt file never wedges requests.
 */
import { mkdirSync } from "node:fs";
import { stateDir } from "./paths.mjs";
import { join } from "node:path";
import { openDb, type SqlDb } from "./sqlite";
import type { AssembledItem } from "./acp/itemAssembler";
import { RETAINED_TURNS } from "./acp/retained";


let cache: SqlDb | null = null;
let broken = false;

function db(): SqlDb | null {
  if (broken) return null;
  if (!cache) {
    try {
      mkdirSync(stateDir(), { recursive: true });
      const d = openDb(join(stateDir(), "itemlog.db"));
      d.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
      d.exec(`CREATE TABLE IF NOT EXISTS turns(
        session_id TEXT NOT NULL,
        turn_id    TEXT NOT NULL,
        start_node INTEGER NOT NULL,
        ended      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(session_id, turn_id))`);
      d.exec(`CREATE TABLE IF NOT EXISTS items(
        session_id TEXT NOT NULL,
        turn_id    TEXT NOT NULL,
        item_id    TEXT NOT NULL,
        ord        INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        role       TEXT,
        text       TEXT,
        tool       TEXT,
        payload    TEXT,
        done       INTEGER NOT NULL,
        seq_from   INTEGER NOT NULL,
        seq_to     INTEGER NOT NULL,
        PRIMARY KEY(session_id, item_id))`);
      d.exec(
        "CREATE INDEX IF NOT EXISTS items_turn ON items(session_id, turn_id, ord)",
      );
      d.exec(`CREATE TABLE IF NOT EXISTS session_meta(
        session_id TEXT PRIMARY KEY,
        json       TEXT NOT NULL,
        updated_at INTEGER NOT NULL)`);
      // retention columns — added 9-23; guarded ALTERs upgrade pre-existing
      // itemlog.db files in place (the file is rebuildable, but a cheap
      // in-place upgrade keeps already-persisted turns)
      const col = (t: string) =>
        new Set(
          (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
            (c) => c.name,
          ),
        );
      if (!col("items").has("anchor_node"))
        d.exec("ALTER TABLE items ADD COLUMN anchor_node INTEGER");
      if (!col("turns").has("retained"))
        d.exec("ALTER TABLE turns ADD COLUMN retained INTEGER NOT NULL DEFAULT 0");
      cache = d;
    } catch {
      broken = true;
      return null;
    }
  }
  return cache;
}

interface ItemRow {
  item_id: string;
  ord: number;
  kind: string;
  role: string | null;
  text: string | null;
  tool: string | null;
  payload: string | null;
  done: number;
  seq_from: number;
  seq_to: number;
  turn_id: string;
  anchor_node: number | null;
}

const rowToItem = (r: ItemRow): AssembledItem => {
  const extra = r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : {};
  return {
    id: r.item_id,
    kind: r.kind as AssembledItem["kind"],
    role: (r.role ?? undefined) as AssembledItem["role"],
    text: r.text ?? undefined,
    tool: r.tool ? (JSON.parse(r.tool) as AssembledItem["tool"]) : undefined,
    done: !!r.done,
    seqFrom: r.seq_from,
    seqTo: r.seq_to,
    ...(r.anchor_node != null ? { anchorNode: r.anchor_node } : {}),
    ...(extra as Partial<AssembledItem>),
  };
};

/** Last-written signature per session — every assembler mutation bumps
 *  `seqTo` or flips `done`, and `ord` catches order shifts, so
 *  `seqTo|done|ord` is a complete change key. The 40ms flush used to
 *  UPSERT the whole region every time (~200x write amplification —
 *  itemlog.db-wal outgrew itemlog.db); now only changed rows write.
 *  Process-local by design: a restart re-baselines on the first save. */
const lastSaved = new Map<
  string,
  { turnId: string; ended: boolean; sigs: Map<string, string> }
>();

/** Replace a turn's persisted region — called on every flush while the
 *  region changes. Fire-and-forget by contract: a failed write only loses
 *  restart fidelity, never blocks the request path. */
export function itemLogSave(
  sessionId: string,
  turnId: string,
  startNode: number,
  items: AssembledItem[],
  ended = false,
) {
  const d = db();
  if (!d) return;
  try {
    const prev = lastSaved.get(sessionId);
    const baseline = prev?.turnId === turnId ? prev : null;
    const sigs = baseline?.sigs ?? new Map<string, string>();
    const nextSigs = new Map<string, string>();
    const up = d.prepare(`INSERT INTO items
      (session_id, turn_id, item_id, ord, kind, role, text, tool, payload, done, seq_from, seq_to)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id, item_id) DO UPDATE SET
        ord=excluded.ord, kind=excluded.kind, role=excluded.role,
        text=excluded.text, tool=excluded.tool, payload=excluded.payload,
        done=excluded.done, seq_from=excluded.seq_from, seq_to=excluded.seq_to`);
    const gone = new Set(items.map((i) => i.id));
    d.exec("BEGIN");
    try {
      if (!baseline || baseline.ended !== ended) {
        d.prepare(
          `INSERT INTO turns(session_id, turn_id, start_node, ended) VALUES (?,?,?,?)
           ON CONFLICT(session_id, turn_id) DO UPDATE SET ended = excluded.ended`,
        ).run(sessionId, turnId, startNode, ended ? 1 : 0);
      }
      // retract items the region no longer carries (turn shrink after
      // finishRole closes the open text item is rare but legal)
      const existing = d
        .prepare("SELECT item_id FROM items WHERE session_id = ? AND turn_id = ?")
        .all(sessionId, turnId) as { item_id: string }[];
      const del = d.prepare("DELETE FROM items WHERE session_id = ? AND item_id = ?");
      for (const e of existing) if (!gone.has(e.item_id)) del.run(sessionId, e.item_id);
      items.forEach((it, ord) => {
        const sig = `${it.seqTo}|${it.done ? 1 : 0}|${ord}`;
        nextSigs.set(it.id, sig);
        if (sigs.get(it.id) === sig) return; // unchanged since last flush
        const { tool, entries, mentions, requestId, method, params, resolved, revisions } = it;
        const payload =
          entries !== undefined ||
          mentions !== undefined ||
          requestId !== undefined ||
          revisions !== undefined
            ? JSON.stringify({ entries, mentions, requestId, method, params, resolved, revisions })
            : null;
        up.run(
          sessionId, turnId, it.id, ord, it.kind,
          it.role ?? null, it.text ?? null,
          tool ? JSON.stringify(tool) : null, payload,
          it.done ? 1 : 0, it.seqFrom, it.seqTo,
        );
      });
      d.exec("COMMIT");
      lastSaved.set(sessionId, { turnId, ended, sigs: nextSigs });
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  } catch {
    /* log failure must never break the turn */
  }
}

/** Turn ended AND durable covers it — convert the region to retained items.
 *  `keep` maps the counterpart-less item ids (thoughts, plans) to the durable
 *  node_id they render after; every other item of the turn is deleted (its
 *  durable twin now renders it). Best-effort like every write here. */
export function itemLogFinalize(
  sessionId: string,
  turnId: string,
  keep: Map<string, number>,
) {
  const d = db();
  if (!d) return;
  try {
    d.exec("BEGIN");
    try {
      const del = d.prepare(
        "DELETE FROM items WHERE session_id = ? AND turn_id = ? AND item_id = ?",
      );
      const keepRows = d
        .prepare("SELECT item_id FROM items WHERE session_id = ? AND turn_id = ?")
        .all(sessionId, turnId) as { item_id: string }[];
      for (const r of keepRows) if (!keep.has(r.item_id)) del.run(sessionId, turnId, r.item_id);
      const anch = d.prepare(
        "UPDATE items SET anchor_node = ? WHERE session_id = ? AND item_id = ?",
      );
      for (const [itemId, node] of keep) anch.run(node, sessionId, itemId);
      // plan revisions are provisional-only — after the flip the durable
      // todo_write tool rows are the history
      d.prepare(
        `UPDATE items SET payload = json_remove(payload, '$.revisions')
         WHERE session_id = ? AND turn_id = ?
         AND json_extract(payload, '$.revisions') IS NOT NULL`,
      ).run(sessionId, turnId);
      d.prepare(
        "UPDATE turns SET retained = 1 WHERE session_id = ? AND turn_id = ?",
      ).run(sessionId, turnId);
      d.exec("COMMIT");
      // re-baseline the write-amplification tracker to the kept set — a
      // (legal) later save of this turn must not resurrect deleted items
      const prev = lastSaved.get(sessionId);
      if (prev?.turnId === turnId) {
        for (const id of [...prev.sigs.keys()]) if (!keep.has(id)) prev.sigs.delete(id);
      }
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  } catch {
    /* non-fatal — the caller's flip path falls back to drop */
  }
}

/** All retained (durable-covered, counterpart-less) items for a session —
 *  every retained turn's items in turn order, then region order. */
export function itemLogLoadRetained(sessionId: string): AssembledItem[] {
  const d = db();
  if (!d) return [];
  try {
    const rows = d
      .prepare(
        `SELECT i.* FROM items i JOIN turns t
           ON t.session_id = i.session_id AND t.turn_id = i.turn_id
         WHERE i.session_id = ? AND t.retained = 1
         ORDER BY t.rowid, i.ord`,
      )
      .all(sessionId) as unknown as ItemRow[];
    return rows.map((r) => {
      const it = rowToItem(r);
      delete it.revisions; // finalize strips them; never leak to consumers
      return it;
    });
  } catch {
    return [];
  }
}

/** Cap retained turns per session — oldest beyond `keep` are dead weight.
 *  Called on new-turn cleanup, never on the read path. */
export function itemLogPruneRetained(sessionId: string, keep = RETAINED_TURNS) {
  const d = db();
  if (!d) return;
  try {
    const stale = d
      .prepare(
        `SELECT turn_id FROM turns WHERE session_id = ? AND retained = 1
         ORDER BY rowid DESC LIMIT -1 OFFSET ?`,
      )
      .all(sessionId, keep) as { turn_id: string }[];
    const delT = d.prepare("DELETE FROM turns WHERE session_id = ? AND turn_id = ?");
    const delI = d.prepare("DELETE FROM items WHERE session_id = ? AND turn_id = ?");
    for (const t of stale) {
      delI.run(sessionId, t.turn_id);
      delT.run(sessionId, t.turn_id);
    }
  } catch {
    /* non-fatal */
  }
}

/** Turn's durable coverage confirmed (or never logged) — drop its rows. */
export function itemLogDrop(sessionId: string, turnId: string) {
  const d = db();
  lastSaved.delete(sessionId);
  if (!d) return;
  try {
    d.prepare("DELETE FROM items WHERE session_id = ? AND turn_id = ?").run(sessionId, turnId);
    d.prepare("DELETE FROM turns WHERE session_id = ? AND turn_id = ?").run(sessionId, turnId);
  } catch {
    /* non-fatal */
  }
}

/** Session deleted — every logged turn (live AND retained) goes with it.
 *  Without this a re-created id restores a dead session's region. */
export function itemLogForget(sessionId: string) {
  const d = db();
  lastSaved.delete(sessionId);
  if (!d) return;
  try {
    d.prepare("DELETE FROM items WHERE session_id = ?").run(sessionId);
    d.prepare("DELETE FROM turns WHERE session_id = ?").run(sessionId);
    d.prepare("DELETE FROM session_meta WHERE session_id = ?").run(sessionId);
  } catch {
    /* non-fatal */
  }
}

/** Durable view meta (modes, config, commands, title, usage) — a web
 *  restart would otherwise show an adopted session without its mode
 *  selector or slash commands until the agent re-sent them (D V1-2).
 *  Fire-and-forget like every write here. */
export function itemLogSaveMeta(sessionId: string, meta: Record<string, unknown>) {
  const d = db();
  if (!d) return;
  try {
    d.prepare(
      `INSERT INTO session_meta(session_id, json, updated_at) VALUES (?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    ).run(sessionId, JSON.stringify(meta), Date.now());
  } catch {
    /* non-fatal */
  }
}

/** session_id → current model's display name, for the session list's model
 *  badges. One scan of session_meta on the cached handle; rows with missing
 *  or corrupt meta simply contribute nothing. */
export function itemLogModelMap(): Map<string, string> {
  const d = db();
  const out = new Map<string, string>();
  if (!d) return out;
  try {
    const rows = d
      .prepare("SELECT session_id, json FROM session_meta")
      .all() as { session_id: string; json: string }[];
    for (const r of rows) {
      try {
        const meta = JSON.parse(r.json) as unknown;
        const opts =
          meta !== null && typeof meta === "object"
            ? (meta as { configOptions?: unknown }).configOptions
            : undefined;
        if (!Array.isArray(opts)) continue;
        const model = opts.find(
          (o): o is Record<string, unknown> =>
            o !== null &&
            typeof o === "object" &&
            ((o as { id?: unknown }).id === "model" ||
              (o as { category?: unknown }).category === "model"),
        );
        if (!model) continue;
        const cur =
          typeof model.currentValue === "string" ? model.currentValue : "";
        if (!cur) continue;
        const named = Array.isArray(model.options)
          ? model.options.find(
              (o): o is Record<string, unknown> =>
                o !== null &&
                typeof o === "object" &&
                (o as { value?: unknown }).value === cur,
            )
          : undefined;
        const name = typeof named?.name === "string" ? named.name : "";
        out.set(r.session_id, name || cur);
      } catch {
        /* corrupt meta row — skip */
      }
    }
  } catch {
    /* non-fatal */
  }
  return out;
}

export function itemLogLoadMeta(sessionId: string): Record<string, unknown> | null {
  const d = db();
  if (!d) return null;
  try {
    const r = d.prepare("SELECT json FROM session_meta WHERE session_id = ?").get(sessionId) as
      | { json: string }
      | undefined;
    if (!r) return null;
    const v = JSON.parse(r.json) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A fresh turn supersedes every older logged LIVE turn for the session —
 *  restore only ever wants the newest. Retained turns are permanent: they
 *  hold the durable-covered thoughts/plans, pruned separately by cap. */
export function itemLogClearExcept(sessionId: string, keepTurnId: string) {
  const d = db();
  lastSaved.delete(sessionId); // the kept turn re-baselines on next save
  if (!d) return;
  try {
    d.prepare(
      `DELETE FROM items WHERE session_id = ? AND turn_id != ?
       AND turn_id NOT IN (SELECT turn_id FROM turns WHERE session_id = ? AND retained = 1)`,
    ).run(sessionId, keepTurnId, sessionId);
    d.prepare(
      "DELETE FROM turns WHERE session_id = ? AND turn_id != ? AND retained = 0",
    ).run(sessionId, keepTurnId);
    itemLogPruneRetained(sessionId);
  } catch {
    /* non-fatal */
  }
}

/** Newest persisted turn for a session — the provisional region to restore
 *  after a mid-turn restart. Null when nothing is logged. */
export function itemLogRestore(
  sessionId: string,
): { turnId: string; startNode: number; ended: boolean; items: AssembledItem[] } | null {
  const d = db();
  if (!d) return null;
  try {
    const latest = d
      .prepare(
        `SELECT * FROM turns WHERE session_id = ? AND retained = 0
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(sessionId) as
      | { turn_id: string; start_node: number; ended: number }
      | undefined;
    if (!latest) return null;
    const rows = d
      .prepare("SELECT * FROM items WHERE session_id = ? AND turn_id = ? ORDER BY ord")
      .all(sessionId, latest.turn_id) as unknown as ItemRow[];
    return {
      turnId: latest.turn_id,
      startNode: latest.start_node,
      ended: !!latest.ended,
      items: rows.map(rowToItem),
    };
  } catch {
    return null;
  }
}

/** Test hook — drop the cached handle so the next call re-opens (and a test
 *  can point DEVIN_WEB_STATE_DIR at a fresh dir). */
export function itemLogResetForTests() {
  try {
    cache?.close();
  } catch {
    /* already closed */
  }
  cache = null;
  broken = false;
  lastSaved.clear();
}
