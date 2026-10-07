import type { SessionState } from "./model";

/** Session fields carried by the versioned view stream. Keep this module
 * browser-safe: the client reads the keys without importing server code. */
export const META_KEYS = [
  "running", "runningSince", "queued", "queueItems", "title", "modeId", "modes",
  "configOptions", "commands", "usage", "turnStats", "terminalIds", "items", "watchers",
] as const;
export type MetaKey = (typeof META_KEYS)[number];
export type ViewMeta = Pick<SessionState, MetaKey>;

/** Only these fields survive a web restart. */
export const PERSISTED_META_KEYS = [
  "title", "modeId", "modes", "configOptions", "commands", "usage", "turnStats",
] as const satisfies readonly MetaKey[];
