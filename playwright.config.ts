import { defineConfig } from "@playwright/test";

/** Round-6 F3: a committed e2e smoke — the SSE disconnect/reconnect →
 *  transcript-preserved path that .playwright-mcp artifacts only probed
 *  ad hoc.
 *
 *  Runs `next build && next start` into a dedicated `.next-e2e` dist dir
 *  (DEVIN_WEB_DIST_DIR) so the build never clobbers `.next` underneath the
 *  live `next start` server — and because `next dev`'s HMR-websocket-gated
 *  hydration is a dev-only path that has nothing to do with what this test
 *  validates. Local mode: acpd/host sockets unset.
 *
 *  Hermetic: a generated `.e2e-fixture/` (CLI dir, state dir, fake `devin`
 *  → test/fixtures/fake-acp.mjs) — never the real sessions or agent.
 *  FAKE_ACP_SCRIPT points at a file specs rewrite per test: on
 *  `session/prompt` the fake agent runs the first turn whose `match`
 *  substring appears in the prompt text (see test/fixtures/fake-acp.mjs).
 *
 *  workers:1 — every spec shares the one fixture agent/state dir, so
 *  parallel pages would cross-talk.
 *
 *  Setup once: `pnpm exec playwright install chromium`
 *  Run:        `pnpm exec playwright test` */

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "**/daemon/**",
  timeout: 45_000,
  retries: 0,
  workers: 1,
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: "http://127.0.0.1:3200",
  },
  // phone is the primary client — every spec runs there. Desktop-only specs
  // (*.desktop.spec.ts) cover the ≥md layout the phone viewport can't see:
  // the right-docked side panel, its left-edge resize, per-tab chips.
  projects: [
    {
      name: "phone",
      use: { viewport: { width: 390, height: 844 } },
      testIgnore: ["**/*.desktop.spec.ts", "**/daemon/**"],
    },
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 800 } },
      testMatch: "**/*.desktop.spec.ts",
    },
  ],
  webServer: {
    command: "node e2e/fixtures/run-server.mjs",
    url: "http://127.0.0.1:3200/api/health",
    timeout: 300_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
  },
});
