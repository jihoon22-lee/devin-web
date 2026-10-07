// `bin` is resolved at runtime (DEVIN_WEB_DEVIN_BIN or PATH) — a statically
// visible execFile(bin, …) makes the bundler trace the whole project as
// potential spawn assets, so the callee stays opaque via getBuiltinModule.
const { execFile } = process.getBuiltinModule("node:child_process");

export interface DevinCliStatus {
  /** e.g. "3000.10.31"; null when the binary could not be run */
  version: string | null;
  /** null when the binary is missing (unknown), false when logged out */
  authed: boolean | null;
}

/** "devin 3000.10.31 (abcdef12)" → "3000.10.31" */
export function parseDevinVersion(out: string): string | null {
  const m = /^devin\s+(\S+)/m.exec(out.trim());
  return m ? m[1] : null;
}

/** `devin auth status` prints "Logged in (…)" and exits 0 when authenticated. */
export function parseAuthed(exitCode: number, out: string): boolean {
  return exitCode === 0 && /logged in/i.test(out) && !/not logged in/i.test(out);
}

/** exit code 127 = the binary itself could not be started */
function run(args: string[]): Promise<{ code: number; out: string }> {
  const bin = process.env.DEVIN_WEB_DEVIN_BIN || "devin";
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 5000 }, (e, stdout, stderr) => {
      const raw = (e as { code?: unknown } | null)?.code;
      const code = !e ? 0 : typeof raw === "number" ? raw : 127;
      resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; value: DevinCliStatus } | null = null;

/** `devin --version` + `devin auth status`, cached for five minutes. */
export async function devinCliStatus(): Promise<DevinCliStatus> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const [v, a] = await Promise.all([run(["--version"]), run(["auth", "status"])]);
  const value: DevinCliStatus = {
    version: v.code === 0 ? parseDevinVersion(v.out) : null,
    authed: a.code === 127 ? null : parseAuthed(a.code, a.out),
  };
  // don't cache a fully-failed probe — a transient spawn failure would
  // otherwise show "devin missing" for the whole TTL
  if (value.version !== null || value.authed !== null) cache = { at: Date.now(), value };
  return value;
}
