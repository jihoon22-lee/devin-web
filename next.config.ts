import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["node-pty"],
  poweredByHeader: false,
  // e2e builds use a separate dist dir so `next build` inside the Playwright
  // webServer never clobbers `.next` underneath the live `next start` server
  distDir: process.env.DEVIN_WEB_DIST_DIR ?? ".next",
  experimental: {
    // proxy.ts makes Next buffer every request body and silently TRUNCATE it
    // past this (default 10MB) — image prompts over ~7.5MB died as
    // "Unterminated string in JSON". Must cover PROMPT_MAX_BODY_BYTES
    // (lib/limits.ts, ~59MB); test/limits.test.ts pins it.
    proxyClientMaxBodySize: "64mb",
  },
};

export default nextConfig;
