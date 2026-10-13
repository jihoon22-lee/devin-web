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
