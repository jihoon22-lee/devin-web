/** "Allow always" rules the devin CLI keeps in its user config
 *  (`permissions.allow` in ~/.config/devin/config.json, e.g. "Exec(sed)").
 *  devin-web only ever REMOVES entries — revoking a grant made from a
 *  phone in a hurry — and rewrites the file atomically, preserving every
 *  other key. A file changed between read and write is re-read once, so a
 *  CLI write landing in between isn't clobbered. */
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function devinConfigPath(): string {
  if (process.env.DEVIN_WEB_DEVIN_CONFIG) return process.env.DEVIN_WEB_DEVIN_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "devin", "config.json");
}

function read(): { cfg: Record<string, unknown>; mtime: number } | null {
  const p = devinConfigPath();
  try {
    const mtime = statSync(/*turbopackIgnore: true*/ p).mtimeMs;
    return { cfg: JSON.parse(readFileSync(/*turbopackIgnore: true*/ p, "utf8")) as Record<string, unknown>, mtime };
  } catch {
    return null;
  }
}

const allowOf = (cfg: Record<string, unknown>): string[] => {
  const a = (cfg.permissions as { allow?: unknown } | undefined)?.allow;
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
};

/** null = config missing or unreadable. */
export function listAllowRules(): string[] | null {
  const r = read();
  return r ? allowOf(r.cfg) : null;
}

/** Remove rules; returns the remaining list, or null when the config
 *  can't be read/written. Unknown rules are ignored. */
export function revokeAllowRules(rules: string[]): string[] | null {
  const drop = new Set(rules);
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = read();
    if (!r) return null;
    const perms = (r.cfg.permissions ?? {}) as Record<string, unknown>;
    const allow = Array.isArray(perms.allow) ? (perms.allow as unknown[]) : [];
    const kept = allow.filter((x) => !(typeof x === "string" && drop.has(x)));
    if (kept.length === allow.length) return allowOf(r.cfg);
    const next = { ...r.cfg, permissions: { ...perms, allow: kept } };
    const p = devinConfigPath();
    try {
      // the CLI wrote the file since our read — start over with its version
      if (statSync(/*turbopackIgnore: true*/ p).mtimeMs !== r.mtime) continue;
      const tmp = `${p}.tmp-${process.pid}`;
      const mode = statSync(/*turbopackIgnore: true*/ p).mode & 0o777;
      writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(next, null, 2) + "\n", { mode });
      renameSync(/*turbopackIgnore: true*/ tmp, p);
      return kept.filter((x): x is string => typeof x === "string");
    } catch {
      return null;
    }
  }
  return null;
}
