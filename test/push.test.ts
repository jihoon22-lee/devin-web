import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "dw-push-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

const push = await import("../lib/push");

const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "p", auth: "a" } });
const sent: { endpoint: string; body: string }[] = [];

beforeEach(() => {
  sent.length = 0;
  push.setPushSenderForTest(async (s, body) => {
    if (s.endpoint.endsWith("/gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
    sent.push({ endpoint: s.endpoint, body });
  });
  for (const s of push.listSubs()) push.removeSub(s.endpoint);
});

describe("lib/push", () => {
  it("generates and persists one VAPID key pair (0600)", () => {
    const k = push.vapidKeys();
    expect(k.publicKey.length).toBeGreaterThan(40);
    expect(statSync(join(stateDir, "vapid.json")).mode & 0o777).toBe(0o600);
    push.setPushSenderForTest(null);
    expect(push.vapidKeys().publicKey).toBe(k.publicKey);
  });

  it("validates, dedupes and removes subscriptions", () => {
    expect(push.addSub({ endpoint: "http://insecure", keys: { p256dh: "p", auth: "a" } })).toBe(false);
    expect(push.addSub(sub(1))).toBe(true);
    expect(push.addSub(sub(1), "phone")).toBe(true);
    expect(push.listSubs()).toHaveLength(1);
    expect(push.listSubs()[0].ua).toBe("phone");
    expect(existsSync(join(stateDir, "push-subs.json"))).toBe(true);
    expect(push.removeSub(sub(1).endpoint)).toBe(true);
    expect(push.listSubs()).toHaveLength(0);
  });

  it("prunes endpoints the push service reports gone", async () => {
    push.addSub(sub(1));
    push.addSub({ ...sub(0), endpoint: "https://push.example/gone" });
    expect(await push.sendPush({ title: "t", body: "b", url: "", tag: "x" })).toBe(1);
    expect(push.listSubs().map((s) => s.endpoint)).toEqual([sub(1).endpoint]);
  });

  it("pushes input requests and turn ends only for unseen sessions, deduped", async () => {
    push.addSub(sub(1));
    const ctx = { title: () => "My session", seen: vi.fn((sid: string) => sid === "watched") };
    push.pushForEvent({ type: "session_update", sessionId: "s1", data: {} }, ctx);
    push.pushForEvent({ type: "client_request", sessionId: "watched", data: {} }, ctx);
    push.pushForEvent({ type: "client_request", sessionId: "s1", data: {} }, ctx);
    push.pushForEvent({ type: "client_request", sessionId: "s1", data: {} }, ctx); // deduped
    push.pushForEvent({ type: "turn_end", sessionId: "s1", data: {} }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.map((s) => JSON.parse(s.body))).toEqual([
      { title: "My session", body: "Waiting for your input", url: "?s=s1", tag: "dw-s1" },
      { title: "My session", body: "Turn finished", url: "?s=s1", tag: "dw-s1" },
    ]);
  });
});
