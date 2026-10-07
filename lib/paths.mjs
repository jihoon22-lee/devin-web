// ONE resolution of the web-owned state directory for every module — TS
// (lib/*, app/*) and plain-node entry points (bin/*.mjs, devin-acpd) alike.
// Lazy: tests point DEVIN_WEB_STATE_DIR at a tmp dir after import.
// bin/devin-web-ctl mirrors the same precedence in bash (test/ctl.test.ts).
import { homedir } from "node:os";
import { join } from "node:path";

/** @returns {string} */
export function stateDir() {
  if (process.env.DEVIN_WEB_STATE_DIR) return process.env.DEVIN_WEB_STATE_DIR;
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "devin-web");
}
