import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { PROMPT_MAX_BODY_BYTES, PROMPT_MAX_IMAGE_BYTES, PROMPT_MAX_TOTAL_BYTES } from "../lib/limits";

/** proxy.ts makes Next buffer request bodies — and silently TRUNCATE them —
 *  at experimental.proxyClientMaxBodySize (default 10MB). The prompt caps
 *  are only real if that limit covers the largest body the route accepts. */
const UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 } as const;
const toBytes = (v: unknown): number => {
  if (typeof v === "number") return v;
  const m = /^(\d+)\s*(b|kb|mb|gb)$/i.exec(String(v));
  if (!m) throw new Error(`unparseable size ${String(v)}`);
  return Number(m[1]) * UNITS[m[2].toLowerCase() as keyof typeof UNITS];
};

describe("prompt body limits (H4)", () => {
  it("next.config's proxy body limit covers the largest accepted prompt body", () => {
    const limit = toBytes(nextConfig.experimental?.proxyClientMaxBodySize ?? 10 * 1024 ** 2);
    expect(limit).toBeGreaterThanOrEqual(PROMPT_MAX_BODY_BYTES);
  });

  it("body budget = base64 of every allowed image + headroom", () => {
    expect(PROMPT_MAX_IMAGE_BYTES).toBeLessThanOrEqual(PROMPT_MAX_TOTAL_BYTES);
    expect(PROMPT_MAX_BODY_BYTES).toBeGreaterThan(Math.ceil((PROMPT_MAX_TOTAL_BYTES * 4) / 3));
  });
});
