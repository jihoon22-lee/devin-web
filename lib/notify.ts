"use client";

/** Notifications: prefer the service worker (survives aggressive background
 *  throttling, required on Android), fall back to the plain Notification API.
 *  Clicking a notification opens its `url` (e.g. "?s=<sessionId>"). */

import { pushEnabledHere } from "./client/push";

let swReg: ServiceWorkerRegistration | null = null;

/** Same-document navigation — AppShell follows ?s= through useSearchParams. */
function openInApp(url: string) {
  window.focus();
  if (url && url !== window.location.search) window.history.pushState(null, "", url);
}

export function registerSw() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { type?: string; url?: unknown } | null;
    if (d?.type === "dw-open" && typeof d.url === "string") openInApp(d.url);
  });
  navigator.serviceWorker
    .register("/sw.js")
    .then((r) => {
      swReg = r;
    })
    .catch(() => {});
}

export function ensureNotifyPermission() {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") void Notification.requestPermission();
}

export function notify(title: string, body?: string, url?: string) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted" || !document.hidden) return;
  // Web Push is on for this device: the server notifies once no visible tab
  // shows the session — a local one as well would buzz twice
  if (pushEnabledHere()) return;
  const opts = { body, icon: "/icon-192.png", tag: `dw-${title}`, data: { url: url ?? "" } };
  if (swReg) {
    swReg.showNotification(title, opts).catch(() => {});
    return;
  }
  try {
    const n = new Notification(title, opts);
    n.onclick = () => {
      openInApp(url ?? "");
      n.close();
    };
  } catch {
    /* some browsers require a service worker — ignore */
  }
}
