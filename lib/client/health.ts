/** /api/health response — shared by the sidebar badge and the diagnostics view. */
export interface Health {
  uptime: number;
  acp: { alive: boolean; pid: number | null; via?: string; degraded?: string | null };
  attached: number;
  host?: boolean | null;
  stream?: {
    connections: number;
    live: number;
    subs: number;
  };
  view?: { sessions: number };
  devin?: { version: string | null; authed: boolean | null };
  /** unavailable means sessions.db could not be opened/read; missing stays empty. */
  cliSchema?: { ok: boolean; missing: string[]; version: number | null; status: "compatible" | "drift" | "unavailable" };
  /** client integrity beacons since boot — transcript regression alarm */
  integrity?: { total: number; lastAt: number | null; lastSig: string | null };
  /** state-dir database/log sizes; `warn` lists files past 1GB */
  storage?: { files: Record<string, number>; total: number; warn: string[] };
}
