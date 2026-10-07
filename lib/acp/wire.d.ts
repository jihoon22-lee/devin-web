/** Wire protocol types for the .mjs daemon/host processes.
 *
 *  These processes are dependency-free Node scripts (no build step), so the
 *  protocol contract lives here and is pulled into JSDoc via
 *  `@type {import("./wire").X}` — the TS side and the .mjs side check
 *  against the same shapes. */

/** JSON-RPC 2.0 envelope shared by every channel (acp, host, shim). */
export interface RpcMsg {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** host.mjs — term/* request methods. */
export type TermMethod =
  | "term/create" | "term/input" | "term/resize" | "term/kill"
  | "term/release" | "term/dismiss" | "term/list" | "term/get_output"
  | "term/snapshot" | "term/attach" | "term/detach" | "term/wait_for_exit";

/** host.mjs — ev/* + sessions/state request methods. */
export type EvMethod = "ev/append" | "ev/since" | "ev/hello" | "sessions/state";

/** host.mjs — server→client notification methods. */
export type HostNotify =
  | "_host/hello" | "_host/replaced" | "_host/db_changed"
  | "_host/term_output" | "_host/term_event";

/** A terminal event pushed on the attached channel. */
export interface TermEvent {
  id: string;
  type?: string;
  exitCode?: number | null;
  released?: boolean;
  [k: string]: unknown;
}

/** ev/append payload — the session event mirror. */
export interface EvAppendParams {
  session: string;
  ev: { type?: string; seq?: number; data?: unknown; [k: string]: unknown };
}

/** ev/since response shape. */
export interface EvSinceResult {
  events: unknown[];
  maxSeq: number;
}

/** daemon.mjs — status file written for lock-free liveness checks. */
export interface AcpdStatus {
  pid: number;
  sessions: string[];
  connectedClient: boolean;
  busy?: Record<string, boolean>;
  [k: string]: unknown;
}

/** host.mjs sessionsProvider — per-session liveness snapshot the host
 *  reports on sessions/state. */
export interface HostSessionInfo {
  sessionId: string;
  cwd: string | null;
  busy: boolean;
  loaded: boolean;
}
