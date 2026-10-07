import { SessionManager } from "./acp/manager";
import { sessionSeen } from "./stream/connections";

declare global {
  var __devinWebManager: SessionManager | undefined;
}

/** Process-wide singleton (survives Next.js dev HMR). */
export function manager(): SessionManager {
  if (!globalThis.__devinWebManager) {
    globalThis.__devinWebManager = new SessionManager();
    globalThis.__devinWebManager.pushSeen = sessionSeen;
  }
  return globalThis.__devinWebManager;
}
