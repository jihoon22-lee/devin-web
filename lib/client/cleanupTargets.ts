/** Pure filter for the sidebar's bulk housekeeping ("Clean old") — keeps
 *  every guard in one testable place so the deletion set is exactly the
 *  sessions nothing can still want back. */

export interface CleanupCandidate {
  sessionId: string;
  active?: boolean;
  isLocked?: boolean;
  archived?: boolean;
  updatedAt?: string | null;
}

/** Sessions eligible for bulk deletion: not loaded in the web acp, not
 *  locked, not the open session, not pinned, not archived (archived means
 *  "keep, just hide"), and provably older than the cutoff — a session
 *  without a timestamp can never be proven old. */
export function cleanupTargets<T extends CleanupCandidate>(
  sessions: readonly T[],
  pins: ReadonlySet<string>,
  selected: string | null,
  cutoff: string,
): T[] {
  return sessions.filter(
    (s) =>
      !s.active &&
      !s.isLocked &&
      s.sessionId !== selected &&
      !s.archived &&
      !pins.has(s.sessionId) &&
      s.updatedAt != null &&
      s.updatedAt < cutoff,
  );
}
