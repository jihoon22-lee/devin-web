#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
let bad = false;
for (const file of files) {
  if (/^(workthrough\/|docs\/superpowers\/)|\.(?:db|sqlite|log|jsonl|pem|key)$|(^|\/)\.env(?:\.|$)/.test(file)) {
    console.error(`Not a public source file: ${file}`); bad = true;
  }
  if (!/\.(?:md|ts|tsx|mjs|js|json|yml|yaml|sh)$/.test(file)) continue;
  const body = readFileSync(file, "utf8");
  // Environment identifiers are not credentials, but must not become examples.
  const homes = [...body.matchAll(/\/home\/([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]);
  if (homes.some((name) => !["example", "user", "runner", "fixture", "test", "alice", "bob", "u", "x", "a"].includes(name))) {
    console.error(`Non-example home path in ${file}`); bad = true;
  }
}
if (bad) process.exit(1);
console.log(`Public file policy checked: ${files.length} files. Run Gitleaks separately for secrets.`);
