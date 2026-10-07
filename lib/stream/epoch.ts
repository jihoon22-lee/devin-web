import { randomUUID } from "node:crypto";

declare global {
  var __devinWebEpoch: string | undefined;
}

/** Identifies this server process. The client compares it across reconnects:
 *  a new value means every event seq and cursor restarted from zero. Kept on
 *  globalThis so dev HMR (which keeps the SessionManager) keeps it too. */
export function serverEpoch(): string {
  if (!globalThis.__devinWebEpoch) globalThis.__devinWebEpoch = randomUUID();
  return globalThis.__devinWebEpoch;
}
