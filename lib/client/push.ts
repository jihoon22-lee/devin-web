"use client";

import { api } from "./api";

/** Browser side of Web Push (server: lib/push.ts). The per-device flag
 *  `dw-push` also tells lib/notify.ts to stand down — the server push
 *  covers this device, a local notification would duplicate it. */
const FLAG = "dw-push";

export type PushStatus = "unsupported" | "needs-install" | "denied" | "off" | "on";

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function pushEnabledHere(): boolean {
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

function setFlag(on: boolean) {
  try {
    if (on) localStorage.setItem(FLAG, "1");
    else localStorage.removeItem(FLAG);
  } catch {
    /* the subscription itself still works */
  }
}

/** serviceWorker.ready never settles when registration failed — bound it
 *  so Settings shows "unsupported" instead of "Checking…" forever */
function swReady(ms = 5000): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("service worker unavailable")), ms)),
  ]);
}

export async function pushStatus(): Promise<PushStatus> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return "unsupported";
  // iOS only exposes Push to a Home Screen web app
  if (!("PushManager" in window)) return isIos() && !standalone() ? "needs-install" : "unsupported";
  if (typeof Notification !== "undefined" && Notification.permission === "denied") return "denied";
  const reg = await swReady();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) {
    setFlag(false);
    return "off";
  }
  setFlag(true);
  return "on";
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function enablePush(): Promise<PushStatus> {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "off";
  const { publicKey } = await api<{ publicKey: string }>("/api/push");
  const reg = await swReady();
  let sub = await reg.pushManager.getSubscription();
  // a subscription made under an older key can't receive — replace it
  if (sub && sub.options.applicationServerKey) {
    const cur = btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (cur !== publicKey) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api("/api/push", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON() }) });
  setFlag(true);
  return "on";
}

export async function disablePush(): Promise<PushStatus> {
  const reg = await swReady();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api("/api/push", { method: "DELETE", body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
    await sub.unsubscribe().catch(() => false);
  }
  setFlag(false);
  return "off";
}

export function testPush(): Promise<{ sent: number }> {
  return api<{ sent: number }>("/api/push/test", { method: "POST" });
}
