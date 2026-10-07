import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    // Playwright specs share the .spec.ts suffix vitest globs for
    exclude: [...configDefaults.exclude, "e2e/**"],
    setupFiles: ["./test/setup-env.ts"],
  },
});
