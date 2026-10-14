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

const CORRUPT_PREFIX = "prompt-queue.json.corrupt-";

/** A queue file that no longer parses is user data, not garbage: set it
 *  aside for manual recovery instead of letting the next write replace it. */
function quarantine(reason: string) {
  const aside = join(stateDir(), `${CORRUPT_PREFIX}${Date.now()}`);
  try {
    renameSync(file(), aside);
    console.error(`[promptQueue] unreadable prompt-queue.json (${reason}) moved to ${aside}; queued attachments are kept until it is resolved`);
  } catch (err) {
    console.error(`[promptQueue] unreadable prompt-queue.json (${reason}) could not be set aside: ${(err as Error).message}`);
  }
}

/** While a set-aside file exists its blobs may still be needed. */
function quarantinePending(): boolean {
  try {
    return readdirSync(stateDir()).some((n) => n.startsWith(CORRUPT_PREFIX));
  } catch {
    return false;
  }
}

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

/** Restore `data` from `dataBlob` markers. An entry whose blob is gone
 *  (ENOENT) is dropped entirely — sending its text without the attachment
 *  would deliver a prompt the user never wrote. Any other read failure
 *  throws: a transiently unreadable blob must fail the whole load rather
 *  than lose the entry on the next save. */
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
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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
/** last load() could not read the queue (or a referenced blob) — writes
 *  must not rename over a file we could not merge, nor sweep its blobs */
let readFailed = false;
let readFailLogged = false;

/** The file (or a blob it references) exists but cannot be read. Keep the
 *  last known-good cache, touch nothing on disk, and let every caller retry
 *  on the next load. Logged once per failure streak. */
function failRead(code: string): Record<string, QueuedPrompt[]> {
  readFailed = true;
  if (!readFailLogged) {
    readFailLogged = true;
    console.error(`[promptQueue] cannot read prompt-queue.json (${code}): queue changes are not persisted until it is readable`);
  }
  return cache ?? {};
}

function load(): Record<string, QueuedPrompt[]> {
  let mtime = -1;
  try {
    mtime = statSync(file()).mtimeMs;
  } catch {
    /* absent */
  }
  // while readFailed, the mtime shortcut must not mask a retry of the read
  if (cache && !readFailed && mtime === cacheMtime) return cache;
  let text: string | null = null;
  try {
    text = readFileSync(file(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return failRead(String((err as NodeJS.ErrnoException).code ?? (err as Error).message));
    }
    text = null; // absent — an empty queue, nothing to preserve
  }
  const out: Record<string, QueuedPrompt[]> = {};
  if (text !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      raw = undefined;
      quarantine((err as Error).message);
    }
    if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
      quarantine("top level is not an object");
    } else if (raw !== undefined) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(v)) continue;
        const q = v.filter(
          (e): e is QueuedPrompt =>
            !!e && typeof e === "object" &&
            typeof (e as QueuedPrompt).id === "string" &&
            Array.isArray((e as QueuedPrompt).blocks),
        );
        try {
          const hydrated: QueuedPrompt[] = [];
          for (const e of q) {
            const h = rehydrateEntry(e);
            if (h) hydrated.push(h);
          }
          if (hydrated.length) out[k] = hydrated;
        } catch (err) {
          return failRead(String((err as NodeJS.ErrnoException).code ?? (err as Error).message));
        }
      }
    }
  }
  cache = out;
  readFailed = false;
  readFailLogged = false;
  try {
    cacheMtime = statSync(file()).mtimeMs;
  } catch {
    cacheMtime = -1; // absent or just set aside
  }
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
  // a set-aside corrupt queue may still reference blobs — keep them all
  if (!quarantinePending()) {
    // sweep blobs no session's queue references anymore — covers entry
    // removal, session deletion and crash leftovers
    try {
      for (const n of readdirSync(blobsDir()))
        if (!referenced.has(n)) unlinkSync(join(blobsDir(), n));
    } catch {
      /* dir absent or a busy file — the next save sweeps */
    }
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
    // an unreadable queue file must not be renamed over or have its blobs
    // swept — the in-memory queue keeps working, only persistence pauses
    // (load already logged the streak)
    if (readFailed) return;
    if (queue.length) map[sessionId] = queue.map((q) => ({ id: q.id, blocks: q.blocks, ...(q.mentionEncoding === "uri" ? { mentionEncoding: "uri" as const } : {}) }));
    else delete map[sessionId];
    save(map);
  } catch (e) {
    console.error(`[promptQueue] persist failed for ${sessionId}: ${(e as Error).message}`);
  }
}
