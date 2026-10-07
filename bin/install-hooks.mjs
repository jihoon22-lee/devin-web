#!/usr/bin/env node
// Installs .git/hooks/pre-push -> `exec pnpm verify`. Runs from
// package.json's `prepare` so the hook survives fresh clones. Local gate
// complements the required GitHub CI checks. Rules:
//   - no .git (tarball / exported tree) or unreadable → quietly succeed
//   - hook missing → write it (0755)
//   - hook identical → just ensure the exec bit
//   - hook exists with DIFFERENT content → keep it, warn — never clobber
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_BODY = `#!/bin/sh
# devin-web: never push unverified work (also enforced by GitHub CI)
exec pnpm verify
`;

export function installHooks({ root = ROOT, log = console.log } = {}) {
  // .git may be a directory (normal clone) or a "gitfile" (worktree/
  // submodule: `gitdir: <path>`) — resolve both without spawning git
  let hooksDir = null;
  try {
    const dotGit = join(root, ".git");
    const st = statSync(dotGit);
    if (st.isDirectory()) {
      hooksDir = join(dotGit, "hooks");
    } else if (st.isFile()) {
      const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (m) hooksDir = join(resolve(root, m[1].trim()), "hooks");
    }
  } catch {
    return 0; // no .git at all — tarball/exported tree, nothing to do
  }
  if (!hooksDir) return 0;

  const dst = join(hooksDir, "pre-push");
  try {
    if (existsSync(dst)) {
      const cur = readFileSync(dst, "utf8");
      if (cur === HOOK_BODY) {
        chmodSync(dst, 0o755); // identical content — keep the exec bit sure
        return 0;
      }
      log(`install-hooks: .git/hooks/pre-push exists with different content — left untouched (wanted: ${JSON.stringify(HOOK_BODY)})`);
      return 0;
    }
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(dst, HOOK_BODY, { mode: 0o755 });
    chmodSync(dst, 0o755); // writeFile mode is umask-filtered — force it
    log("install-hooks: installed .git/hooks/pre-push (pnpm verify)");
  } catch (e) {
    log(`install-hooks: skipped (${e instanceof Error ? e.message : e})`);
  }
  return 0;
}

const IS_MAIN =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) installHooks();
