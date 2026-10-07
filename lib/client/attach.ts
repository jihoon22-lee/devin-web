export type AttachPrior = "inflight" | "ok" | "failed" | "missing-checked" | undefined;
export type AttachDecision = "wait" | "recheck" | "missing" | "none" | "attach";

export interface AttachTarget {
  active?: boolean;
  lockedBy?: { ours: boolean };
}

export interface AttachInput {
  /** at least one /api/sessions response has arrived */
  listLoaded: boolean;
  /** the selected session as listed, or null if absent from the list */
  current: AttachTarget | null;
  readOnly: boolean;
  /** outcome of the previous auto-attach for this session id */
  prior: AttachPrior;
}

/** What to do for the session selected in the URL. A session opened by URL,
 *  after a server restart, or after an acp restart is listed but not attached
 *  — sending to it fails with "not loaded", so attach it automatically.
 *  "failed" is sticky (user retries explicitly); "ok" is not, so a later
 *  restart re-attaches. A missing session is re-fetched once first because a
 *  just-forked/created session may not be listed yet. */
export function decideAttach(o: AttachInput): AttachDecision {
  if (!o.listLoaded) return "wait";
  if (!o.current) return o.prior === "missing-checked" ? "missing" : "recheck";
  if (o.readOnly) return "none";
  if (o.current.active || o.current.lockedBy?.ours) return "none";
  if (o.prior === "inflight" || o.prior === "failed") return "none";
  return "attach";
}
