/** Pure request gate used by proxy.ts. devin-web has no app auth, so this is
 *  the only barrier between an arbitrary web page and a shell on this machine:
 *  - foreign Host  → DNS rebinding → 421
 *  - cross-site / header-less API writes → CSRF → 403
 *  Kept free of Node/Next imports so the client can share CSRF_HEADER. */

export const CSRF_HEADER = "x-devin-web";

export interface GuardInput {
  method: string;
  pathname: string;
  host: string | null;
  /** set by reverse proxies (tailscale serve) that rewrite Host */
  forwardedHost: string | null;
  origin: string | null;
  secFetchSite: string | null;
  csrfHeader: string | null;
  extraHosts: string[];
  /** DEVIN_WEB_TAILNET — pins the accepted *.ts.net suffix */
  tailnet?: string | null;
}

export type GuardResult = { ok: true } | { ok: false; status: 403 | 421; reason: string };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

export function isAllowedHost(
  hostHeader: string | null,
  extraHosts: string[],
  tailnet?: string | null,
): boolean {
  if (!hostHeader) return false;
  const name = hostnameOf(hostHeader);
  if (LOOPBACK.has(name)) return true;
  if (name.endsWith(".ts.net")) {
    // DEVIN_WEB_TAILNET pins the MagicDNS suffix — any other tailnet's
    // (Funnel-published) names are foreign hosts
    const tn = tailnet?.trim().toLowerCase();
    return !tn || name.endsWith(`.${tn}`);
  }
  return extraHosts.some((x) => x.trim().toLowerCase() === name);
}

const deny = (status: 403 | 421, reason: string): GuardResult => ({ ok: false, status, reason });

export function checkRequest(i: GuardInput): GuardResult {
  if (!isAllowedHost(i.host, i.extraHosts, i.tailnet)) return deny(421, `host not allowed: ${i.host ?? "(none)"}`);
  if (SAFE_METHODS.has(i.method.toUpperCase()) || !i.pathname.startsWith("/api/")) return { ok: true };

  if (i.secFetchSite && i.secFetchSite !== "same-origin" && i.secFetchSite !== "none") {
    return deny(403, `cross-site request (${i.secFetchSite})`);
  }
  if (i.origin === "null") return deny(403, "opaque origin");
  if (i.origin) {
    let originHost: string;
    try {
      originHost = new URL(i.origin).host.toLowerCase();
    } catch {
      return deny(403, `bad origin: ${i.origin}`);
    }
    const accepted = [i.host, i.forwardedHost].filter(Boolean).map((h) => h!.toLowerCase());
    if (!accepted.includes(originHost)) return deny(403, `origin mismatch: ${i.origin}`);
  }
  if (i.csrfHeader !== "1") return deny(403, `missing ${CSRF_HEADER} header`);
  return { ok: true };
}

/** Response headers for every proxied request. With no app auth, a framed
 *  devin-web is a same-origin client: a hostile page could overlay it and
 *  steer clicks or Y / Shift+A keypresses onto a permission card
 *  (clickjacking) — frame-ancestors/XFO forbid embedding outright. img-src
 *  stops agent-written markdown from beaconing data out through a remote
 *  image URL (Markdown.tsx gates those behind a click as well). Script
 *  sources stay unrestricted: Next's inline bootstrap would need nonces. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
