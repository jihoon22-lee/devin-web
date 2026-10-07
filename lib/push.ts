/** Web Push — reaches a phone whose devin-web tab is closed or asleep.
 *
 *  Keys and subscriptions live in $STATE_DIR (vapid.json / push-subs.json,
 *  atomic 0600 writes). The server decides WHEN to push from session events
 *  (pushForEvent, called by SessionManager.emit): a permission/question card
 *  arriving, or a turn ending. A session some visible tab is viewing gets no
 *  push — that tab already shows it (sessionSeen). Every send is
 *  fire-and-forget with its own catch; a dead endpoint (404/410) is pruned. */
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import webpush, { type PushSubscription } from "web-push";
import { stateDir } from "./paths.mjs";

export interface StoredSub extends PushSubscription {
  /** user agent at subscribe time — shown in Settings to tell devices apart */
  ua?: string;
  at: number;
}

export interface PushPayload {
  title: string;
  body: string;
  /** app-relative URL the notification opens, e.g. "?s=<sessionId>" */
  url: string;
  /** same tag replaces the previous notification instead of stacking */
  tag: string;
}

const MAX_SUBS = 20;
const vapidFile = () => join(stateDir(), "vapid.json");
const subsFile = () => join(stateDir(), "push-subs.json");

function writeAtomic(file: string, data: unknown) {
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

let keys: { publicKey: string; privateKey: string } | null = null;

/** VAPID key pair, generated once per state dir. */
export function vapidKeys(): { publicKey: string; privateKey: string } {
  if (keys) return keys;
  try {
    const k = JSON.parse(readFileSync(vapidFile(), "utf8")) as { publicKey?: unknown; privateKey?: unknown };
    if (typeof k.publicKey === "string" && typeof k.privateKey === "string") {
      keys = { publicKey: k.publicKey, privateKey: k.privateKey };
      return keys;
    }
  } catch {
    /* first use — generate below */
  }
  keys = webpush.generateVAPIDKeys();
  writeAtomic(vapidFile(), keys);
  return keys;
}

let subsCache: StoredSub[] | null = null;

export function listSubs(): StoredSub[] {
  if (subsCache) return subsCache;
  try {
    const raw = JSON.parse(readFileSync(subsFile(), "utf8")) as unknown;
    subsCache = Array.isArray(raw) ? (raw as StoredSub[]).filter(validSub) : [];
  } catch {
    subsCache = [];
  }
  return subsCache;
}

function validSub(s: unknown): s is StoredSub {
  const o = s as StoredSub | null;
  return (
    !!o &&
    typeof o.endpoint === "string" &&
    /^https:\/\//.test(o.endpoint) &&
    o.endpoint.length <= 2048 &&
    typeof o.keys?.p256dh === "string" &&
    typeof o.keys?.auth === "string"
  );
}

function saveSubs(list: StoredSub[]) {
  subsCache = list;
  try {
    writeAtomic(subsFile(), list);
  } catch (e) {
    console.error(`[push] could not save subscriptions: ${(e as Error).message}`);
  }
}

/** Add or refresh a browser subscription. false = malformed input. */
export function addSub(sub: unknown, ua?: string): boolean {
  if (!validSub(sub)) return false;
  const entry: StoredSub = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    ...(ua ? { ua: ua.slice(0, 200) } : {}),
    at: Date.now(),
  };
  const rest = listSubs().filter((s) => s.endpoint !== entry.endpoint);
  saveSubs([...rest, entry].slice(-MAX_SUBS));
  return true;
}

export function removeSub(endpoint: string): boolean {
  const list = listSubs();
  const next = list.filter((s) => s.endpoint !== endpoint);
  if (next.length === list.length) return false;
  saveSubs(next);
  return true;
}

type Sender = (sub: PushSubscription, body: string) => Promise<unknown>;

const defaultSender: Sender = (sub, body) => {
  const k = vapidKeys();
  return webpush.sendNotification(sub, body, {
    TTL: 3600,
    urgency: "high",
    // a push service that never answers must not pin sockets forever
    timeout: 10_000,
    vapidDetails: {
      subject: process.env.DEVIN_WEB_PUSH_SUBJECT || "mailto:devin-web@example.com",
      publicKey: k.publicKey,
      privateKey: k.privateKey,
    },
  });
};
let sender: Sender = defaultSender;

/** Test hook — pass null to restore the real web-push sender. */
export function setPushSenderForTest(fn: Sender | null) {
  sender = fn ?? defaultSender;
  subsCache = null;
  keys = null;
}

/** Fan a payload out to every subscription. Never throws. */
export async function sendPush(payload: PushPayload): Promise<number> {
  const subs = listSubs();
  if (!subs.length) return 0;
  const body = JSON.stringify(payload);
  let ok = 0;
  const dead: string[] = [];
  await Promise.all(
    subs.map((s) =>
      sender(s, body)
        .then(() => {
          ok++;
        })
        .catch((e: { statusCode?: number; message?: string }) => {
          if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(s.endpoint);
          else console.error(`[push] send failed (${e?.statusCode ?? "?"}): ${e?.message ?? e}`);
        }),
    ),
  );
  if (dead.length) saveSubs(listSubs().filter((s) => !dead.includes(s.endpoint)));
  return ok;
}

/** last push per session+kind — a burst of permission cards (or a turn_end
 *  followed by a turn_error) must not buzz the phone repeatedly */
const lastSent = new Map<string, number>();
const DEDUPE_MS = 15_000;

export interface PushContext {
  title(sessionId: string): string | undefined;
  /** a visible tab is showing this session — no push needed */
  seen(sessionId: string): boolean;
}

/** Decide whether a session event warrants a push, and send it. Cheap for
 *  the common case (streaming chunks): a type check and out. */
export function pushForEvent(
  ev: { type: string; sessionId?: string; data: unknown },
  ctx: PushContext,
): void {
  const sid = ev.sessionId;
  if (!sid) return;
  let kind: "input" | "done" | "error";
  if (ev.type === "client_request") kind = "input";
  else if (ev.type === "turn_end") kind = "done";
  else if (ev.type === "turn_error") kind = "error";
  else return;
  if (!listSubs().length || ctx.seen(sid)) return;
  const key = `${sid}:${kind}`;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < DEDUPE_MS) return;
  lastSent.set(key, now);
  if (lastSent.size > 500) lastSent.clear();
  const title = ctx.title(sid)?.trim() || "devin-web";
  const body =
    kind === "input"
      ? "Waiting for your input"
      : kind === "done"
        ? "Turn finished"
        : `Turn failed: ${String((ev.data as { message?: unknown } | null)?.message ?? "error").slice(0, 120)}`;
  void sendPush({ title, body, url: `?s=${encodeURIComponent(sid)}`, tag: `dw-${sid}` }).catch(() => {});
}
