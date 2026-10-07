import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  use: { baseURL: "http://127.0.0.1:3201", viewport: { width: 1280, height: 800 } },
  webServer: {
    command: "node e2e/fixtures/run-server.mjs --daemon",
    cwd: resolve(__dirname, "../.."),
    url: "http://127.0.0.1:3201/api/health",
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
  },
});
