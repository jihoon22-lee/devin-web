import { resolve } from "node:path";
import { cwdRootsError } from "./fsRoots";

/** load/takeover/fork take a cwd for an EXISTING session. It passes when it
 *  lies inside DEVIN_WEB_FS_ROOTS or equals that session's own recorded cwd —
 *  CLI-created sessions outside the roots keep working; arbitrary
 *  directories cannot widen the gate. */
export async function existingSessionCwdError(
  cwd: string,
  recorded: () => Promise<string | undefined>,
): Promise<string | null> {
  const denied = cwdRootsError(cwd);
  if (!denied) return null;
  const own = await recorded().catch(() => undefined);
  return own && resolve(own) === resolve(cwd) ? null : denied;
}

/** A session's recorded cwd — attached sessions first, then the durable
 *  list. An adopted session without a daemon-recorded cwd carries the web's
 *  default as a placeholder (`cwdUnknown`) — it is not the session's own
 *  cwd, so fall through to the recorded entry. */
export async function recordedSessionCwd(
  id: string,
  m: {
    getSession(id: string): { cwd: string; cwdUnknown?: boolean } | undefined;
    listSessions(): Promise<{ sessionId: string; cwd?: string }[]>;
  },
): Promise<string | undefined> {
  const s = m.getSession(id);
  return (s && !s.cwdUnknown ? s.cwd : undefined)
    ?? (await m.listSessions()).find((x) => x.sessionId === id)?.cwd;
}
