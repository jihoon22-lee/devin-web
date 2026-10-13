#!/usr/bin/env node
// Installs .git/hooks/pre-push -> `exec pnpm verify`. Runs from
// package.json's `prepare` so the hook survives fresh clones. Local gate
// complements the required GitHub CI checks. Rules:
//   - no .git (tarball / exported tree) or unreadable → quietly succeed
//   - hook missing → write it (0755)
//   - hook identical → just ensure the exec bit
//   - hook exists with DIFFERENT content → keep it, warn — never clobber
//   - core.hooksPath scoped outside this repo → skip with a notice (a shared
//     hooks dir would run `pnpm verify` for every repo)
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gitEnvironment } from "../lib/gitEnv.mjs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_BODY = `#!/bin/sh
# devin-web: never push unverified work (also enforced by GitHub CI)
exec pnpm verify
`;

// Scope of the winning core.hooksPath value: the last `config --get-all`
// line's first token. null = unset (exit 1/empty); "unknown" = the query
// itself failed — fail closed rather than write into an untracked scope.
function hooksPathScope(root) {
  let out;
  try {
    out = execFileSync("git", ["-C", root, "config", "--show-scope", "--get-all", "core.hooksPath"], { encoding: "utf8", env: gitEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return e && typeof e === "object" && e.status === 1 ? null : "unknown";
  }
  const lines = out.trim().split("\n").filter(Boolean);
  if (!lines.length) return null;
  return lines.at(-1).split(/\s+/, 1)[0];
}

export function installHooks({ root = ROOT, log = console.log } = {}) {
  // Ask Git: linked worktrees share the common hooks directory, and
  // core.hooksPath (including inherited configuration) overrides it.
  if (!existsSync(join(root, ".git"))) return 0;
  let dst;
  try {
    dst = resolve(root, execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"], { encoding: "utf8", env: gitEnvironment(), stdio: ["ignore", "pipe", "pipe"] }).trim());
  } catch { return 0; } // Git-free archives/installations remain supported.
  // A hooksPath set outside this repo (global/system/command scope) would
  // drop our `pnpm verify` hook into a directory shared by EVERY repo —
  // install nowhere instead. Only repo-local intent (local/worktree scope)
  // or no override at all is honored.
  const scope = hooksPathScope(root);
  if (scope !== null && scope !== "local" && scope !== "worktree") {
    log(scope === "unknown"
      ? "install-hooks: core.hooksPath scope could not be determined — pre-push hook not installed; run `pnpm verify` before pushing"
      : `install-hooks: core.hooksPath is configured outside this repository (${scope} scope) — pre-push hook not installed; run \`pnpm verify\` before pushing`);
    return 0;
  }
  const hooksDir = dirname(dst);
  try {
    if (existsSync(dst)) {
      const cur = readFileSync(dst, "utf8");
      if (cur === HOOK_BODY) {
        chmodSync(dst, 0o755); // identical content — keep the exec bit sure
        return 0;
      }
      log(`install-hooks: ${dst} exists with different content — left untouched (wanted: ${JSON.stringify(HOOK_BODY)})`);
      return 0;
    }
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(dst, HOOK_BODY, { mode: 0o755 });
    chmodSync(dst, 0o755); // writeFile mode is umask-filtered — force it
    log(`install-hooks: installed ${dst} (pnpm verify)`);
  } catch (e) {
    log(`install-hooks: skipped (${e instanceof Error ? e.message : e})`);
  }
  return 0;
}

const IS_MAIN =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) installHooks();
