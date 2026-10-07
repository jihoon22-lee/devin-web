/** Queued prompts are user data — an in-memory-only queue silently dropped
 *  them on every web restart (and the daemon mirror kept replaying the stale
 *  `queued:1` session_state, resurrecting ghost bubbles that dequeue could
 *  not find). Persisted verbatim per sessionId; hydrated onto the session
 *  record at attach so the normal drain paths deliver them late instead of
 *  never. */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { stateDir } from "./paths.mjs";
import { join } from "node:path";
import type { ContentBlock } from "./acp/types";

// lazy: tests point DEVIN_WEB_STATE_DIR at a tmp dir after module load
const file = () => join(stateDir(), "prompt-queue.json");
const blobsDir = () => join(stateDir(), "queue-blobs");

/** Base64 chars above which an image/audio payload is stored out-of-line.
 *  The JSON file is rewritten on EVERY queue mutation — with inline data a
 *  single parked max-size prompt stalls the event loop ~200ms per change
 *  (measured 2026-09-30). Small attachments stay inline. */
const BLOB_OFFLOAD_CHARS = 512 * 1024;

// queue ids are immutable per entry (an edit is dequeue + a new id), so
// <sid>--<qid>-<index> names a stable payload — safe to skip a rewrite when
// the blob already holds it
const blobName = (sid: string, qid: string, i: number) =>
  `${sid.replace(/[^A-Za-z0-9._-]/g, "_")}--${qid}-${i}`;

type SerializedBlock = Record<string, unknown>;

/** Swap large inline payloads for `dataBlob` markers in the serialized copy.
 *  Falls back to inline when the blob can't be written — losing the payload
 *  is worse than a large file. */
function offloadBlocks(sid: string, qid: string, blocks: ContentBlock[], referenced: Set<string>): SerializedBlock[] {
  return blocks.map((b, i) => {
    if (b.type !== "image" && b.type !== "audio") return b;
    if (typeof b.data !== "string" || b.data.length <= BLOB_OFFLOAD_CHARS) return b;
    const name = blobName(sid, qid, i);
    const p = join(blobsDir(), name);
    try {
      mkdirSync(blobsDir(), { recursive: true });
      if (!(existsSync(p) && statSync(p).size === b.data.length))
        writeFileSync(p, b.data, { mode: 0o600 });
      referenced.add(name);
      const rest: SerializedBlock = { ...b };
      delete rest.data;
      return { ...rest, dataBlob: name };
    } catch {
      return b;
    }
  });
}

/** Restore `data` from `dataBlob` markers. An entry whose blob is missing or
 *  unreadable is dropped entirely — sending its text without the attachment
 *  would deliver a prompt the user never wrote. */
function rehydrateEntry(e: QueuedPrompt): QueuedPrompt | null {
  const blocks: ContentBlock[] = [];
  for (const b of e.blocks) {
    const name = (b as { dataBlob?: unknown }).dataBlob;
    if (typeof name !== "string") {
      blocks.push(b);
      continue;
    }
    let data: string;
    try {
      data = readFileSync(join(blobsDir(), name), "utf8");
    } catch (err) {
      console.error(`[promptQueue] unreadable blob ${name} — dropping queued prompt ${e.id}: ${(err as Error).message}`);
      return null;
    }
    const rest: SerializedBlock = { ...(b as ContentBlock) };
    delete rest.dataBlob;
    blocks.push({ ...rest, data } as ContentBlock);
  }
  return { ...e, blocks };
}

export interface QueuedPrompt {
  id: string;
  blocks: ContentBlock[];
  /** Absent in old queues, whose resource links contained literal paths. */
  mentionEncoding?: "uri";
}

let cache: Record<string, QueuedPrompt[]> | null = null;
let cacheMtime = -1;

function load(): Record<string, QueuedPrompt[]> {
  let mtime = -1;
  try {
    mtime = statSync(file()).mtimeMs;
  } catch {
    /* absent */
  }
  if (cache && mtime === cacheMtime) return cache;
  try {
    const raw: unknown = JSON.parse(readFileSync(file(), "utf8"));
    const out: Record<string, QueuedPrompt[]> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(v)) continue;
        const q = v.filter(
          (e): e is QueuedPrompt =>
            !!e && typeof e === "object" &&
            typeof (e as QueuedPrompt).id === "string" &&
            Array.isArray((e as QueuedPrompt).blocks),
        );
        const hydrated: QueuedPrompt[] = [];
        for (const e of q) {
          const h = rehydrateEntry(e);
          if (h) hydrated.push(h);
        }
        if (hydrated.length) out[k] = hydrated;
      }
    }
    cache = out;
  } catch {
    cache = {};
  }
  cacheMtime = mtime;
  return cache;
}

function save(map: Record<string, QueuedPrompt[]>) {
  mkdirSync(stateDir(), { recursive: true });
  // serialize against a transformed copy — the cache keeps the real blocks
  // so readAllQueues() callers never see dataBlob markers
  const referenced = new Set<string>();
  const ser: Record<string, unknown> = {};
  for (const [sid, queue] of Object.entries(map))
    ser[sid] = queue.map((q) => ({
      id: q.id,
      ...(q.mentionEncoding ? { mentionEncoding: q.mentionEncoding } : {}),
      blocks: offloadBlocks(sid, q.id, q.blocks, referenced),
    }));
  // blobs land BEFORE the JSON rename: a crash mid-save leaves an orphan
  // blob (swept below), never a dangling marker
  const tmp = `${file()}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(ser) + "\n", { mode: 0o600 });
  renameSync(tmp, file());
  // sweep blobs no session's queue references anymore — covers entry
  // removal, session deletion and crash leftovers
  try {
    for (const n of readdirSync(blobsDir()))
      if (!referenced.has(n)) unlinkSync(join(blobsDir(), n));
  } catch {
    /* dir absent or a busy file — the next save sweeps */
  }
  cache = map;
  try {
    cacheMtime = statSync(file()).mtimeMs;
  } catch {
    cacheMtime = -1;
  }
}

/** Everything persisted — sessions hydrate their record from this at attach. */
export function readAllQueues(): Record<string, QueuedPrompt[]> {
  return load();
}

/** Mirror the session's in-memory queue to disk — call after every mutation.
 *  Best-effort by contract: this runs inside `runPrompt`'s `finally`, which
 *  nothing awaits, so a throw here (full disk, read-only state dir, a removed
 *  $STATE_DIR) became an unhandled rejection that took the web process down
 *  mid-turn. Losing the mirror only costs restart fidelity — the in-memory
 *  queue still drains normally — so failing loudly is strictly worse. */
export function writeSessionQueue(sessionId: string, queue: QueuedPrompt[]) {
  try {
    const map = { ...load() };
    if (queue.length) map[sessionId] = queue.map((q) => ({ id: q.id, blocks: q.blocks, ...(q.mentionEncoding === "uri" ? { mentionEncoding: "uri" as const } : {}) }));
    else delete map[sessionId];
    save(map);
  } catch (e) {
    console.error(`[promptQueue] persist failed for ${sessionId}: ${(e as Error).message}`);
  }
}
