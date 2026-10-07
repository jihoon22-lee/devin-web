import { NextResponse, type NextRequest } from "next/server";
import { CSRF_HEADER, SECURITY_HEADERS, checkRequest } from "@/lib/security/requestGuard";

const extraHosts = (process.env.DEVIN_WEB_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const tailnet = process.env.DEVIN_WEB_TAILNET?.trim() || null;

export function proxy(req: NextRequest) {
  const h = req.headers;
  const r = checkRequest({
    method: req.method,
    pathname: req.nextUrl.pathname,
    host: h.get("host"),
    forwardedHost: h.get("x-forwarded-host"),
    origin: h.get("origin"),
    secFetchSite: h.get("sec-fetch-site"),
    csrfHeader: h.get(CSRF_HEADER),
    extraHosts,
    tailnet,
  });
  const res = r.ok ? NextResponse.next() : NextResponse.json({ error: r.reason }, { status: r.status });
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
