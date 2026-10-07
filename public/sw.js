// devin-web service worker — exists so notifications can be posted via
// registration.showNotification (works even when the tab is backgrounded
// more aggressively than `new Notification` allows, e.g. Android Chrome).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Network blips (tailnet rebinding, VPN doze) currently surface as the
// browser's "This page couldn't load" on navigations. Catch failed
// navigation fetches and answer with a tiny self-reloading page instead —
// it retries every few seconds and the moment the tunnel is back the app
// reappears without the user tapping Reload.
const OFFLINE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>devin-web — reconnecting</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;
align-items:center;justify-content:center;margin:0;background:#0b0e14;color:#e6e9ef}
.c{text-align:center;max-width:320px}.s{width:28px;height:28px;margin:0 auto 16px;
border:3px solid #334;border-top-color:#7aa2ff;border-radius:50%;animation:r 1s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}p{color:#9aa3b2;font-size:14px}</style>
</head><body><div class="c"><div class="s"></div>
<h3>Connection lost</h3><p>Retrying automatically…</p></div>
<script>
function retry(){ fetch(location.href,{method:"HEAD",cache:"no-store"})
  .then(function(r){ if(r.ok) location.reload(); else setTimeout(retry,3000); })
  .catch(function(){ setTimeout(retry,3000); }); }
setTimeout(retry,1500);
addEventListener("online",function(){ location.reload(); });
</script></body></html>`;

const fallback = () =>
  new Response(OFFLINE_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });

self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return; // only page loads — never APIs/SSE
  e.respondWith(
    fetch(e.request).then((r) => {
      // a proxy-level 5xx (tailscale serve while the web restarts) is just as
      // unreachable as a refused connection — serve the auto-retrying page.
      // App 500s (real route bugs) still pass through so they stay visible.
      if (r.status === 502 || r.status === 503 || r.status === 504) return fallback();
      return r;
    }).catch(fallback),
  );
});

// Web Push (lib/push.ts): the server only pushes when no visible tab shows
// the session, so always surface it — browsers penalize silent pushes.
self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || "devin-web", {
      body: d.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: d.tag || "dw",
      renotify: true,
      data: { url: d.url || "" },
    }),
  );
});

// Clicking focuses an open app window and asks it to show the notification's
// session (data.url, e.g. "?s=<id>"); with no window open, open one there.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "";
  e.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        for (const c of list) {
          if ("focus" in c) {
            if (url) c.postMessage({ type: "dw-open", url });
            return c.focus();
          }
        }
        return self.clients.openWindow("/" + url);
      }),
  );
});
