import { describe, expect, it } from "vitest";
import { checkRequest, hostnameOf, isAllowedHost, type GuardInput } from "../lib/security/requestGuard";
import { SECURITY_HEADERS } from "../lib/security/requestGuard";

const base: GuardInput = {
  method: "GET",
  pathname: "/api/sessions",
  host: "127.0.0.1:7100",
  forwardedHost: null,
  origin: null,
  secFetchSite: null,
  csrfHeader: null,
  extraHosts: [],
};
const post = (over: Partial<GuardInput>): GuardInput => ({
  ...base,
  method: "POST",
  origin: "http://127.0.0.1:7100",
  secFetchSite: "same-origin",
  csrfHeader: "1",
  ...over,
});

describe("hostnameOf", () => {
  it("strips ports and keeps ipv6 brackets", () => {
    expect(hostnameOf("127.0.0.1:7100")).toBe("127.0.0.1");
    expect(hostnameOf("[::1]:7100")).toBe("[::1]");
    expect(hostnameOf("Main.Tail1234.TS.net:7100")).toBe("main.tail1234.ts.net");
  });
});

describe("isAllowedHost", () => {
  it("allows loopback, tailnet and configured extras only", () => {
    expect(isAllowedHost("localhost:7100", [])).toBe(true);
    expect(isAllowedHost("[::1]:7100", [])).toBe(true);
    expect(isAllowedHost("main.tail1234.ts.net:7100", [])).toBe(true);
    expect(isAllowedHost("100.64.0.10:7100", ["100.64.0.10"])).toBe(true);
    expect(isAllowedHost("attacker.example:7100", [])).toBe(false);
    expect(isAllowedHost("evil-ts.net:7100", [])).toBe(false);
    expect(isAllowedHost(null, [])).toBe(false);
  });
});

describe("checkRequest", () => {
  it("lets same-machine GETs through", () => {
    expect(checkRequest(base)).toEqual({ ok: true });
  });

  it("rejects a foreign Host even for GET (DNS rebinding)", () => {
    const r = checkRequest({ ...base, host: "attacker.example:7100" });
    expect(r).toMatchObject({ ok: false, status: 421 });
  });

  it("accepts a same-origin POST carrying the csrf header", () => {
    expect(checkRequest(post({}))).toEqual({ ok: true });
  });

  it("rejects a cross-site simple POST (text/plain CSRF)", () => {
    const r = checkRequest(post({ origin: "https://evil.example", secFetchSite: "cross-site", csrfHeader: null }));
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects an origin mismatch even without Sec-Fetch-Site (old browsers)", () => {
    const r = checkRequest(post({ origin: "https://evil.example", secFetchSite: null }));
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects an opaque 'null' origin", () => {
    expect(checkRequest(post({ origin: "null", secFetchSite: null }))).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects a POST without the csrf header (e.g. form post)", () => {
    expect(checkRequest(post({ csrfHeader: null }))).toMatchObject({ ok: false, status: 403 });
  });

  it("accepts tailscale serve traffic where Host was rewritten to loopback", () => {
    const r = checkRequest(post({
      host: "127.0.0.1:7100",
      forwardedHost: "main.tail1234.ts.net:7100",
      origin: "https://main.tail1234.ts.net:7100",
    }));
    expect(r).toEqual({ ok: true });
  });

  it("does not gate non-API POSTs beyond the host check", () => {
    expect(checkRequest(post({ pathname: "/", csrfHeader: null }))).toEqual({ ok: true });
  });
});

describe("tailnet pin (R12 C8)", () => {
  it("accepts only the configured tailnet when set", () => {
    const tn = "tail1234.ts.net";
    expect(isAllowedHost("box.tail1234.ts.net", [], tn)).toBe(true);
    expect(isAllowedHost("box.tail1234.ts.net:7100", [], tn)).toBe(true);
    expect(isAllowedHost("evil.tail9999.ts.net", [], tn)).toBe(false);
    expect(isAllowedHost("xtail1234.ts.net", [], tn)).toBe(false);
    expect(isAllowedHost("127.0.0.1:7100", [], tn)).toBe(true);
  });

  it("keeps the any-*.ts.net default when unset", () => {
    expect(isAllowedHost("evil.tail9999.ts.net", [], null)).toBe(true);
    expect(isAllowedHost("evil.tail9999.ts.net", [])).toBe(true);
  });

  it("checkRequest applies the pin", () => {
    const base = { method: "GET", pathname: "/", forwardedHost: null, origin: null, secFetchSite: null, csrfHeader: null, extraHosts: [] };
    expect(checkRequest({ ...base, host: "evil.tail9999.ts.net", tailnet: "tail1234.ts.net" }).ok).toBe(false);
  });
});

describe("security response headers", () => {
  it("forbid framing and remote images on every proxied response", async () => {
    const { proxy } = await import("../proxy");
    const { NextRequest } = await import("next/server");
    for (const [url, host] of [["http://127.0.0.1:7100/", "127.0.0.1:7100"], ["http://evil.example/", "evil.example"]]) {
      const res = proxy(new NextRequest(url, { headers: { host } }));
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("content-security-policy")).toContain("img-src 'self' data: blob:");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
  });
});
