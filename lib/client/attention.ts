/** Sessions whose unanswered permission/elicitation count went UP since the
 *  previous /api/sessions poll — excluding the session on screen (its card
 *  is already visible there). The first poll is a baseline: prev === null. */
export function attentionDelta<T extends { sessionId: string; pendingRequests?: number }>(
  prev: Map<string, number> | null,
  sessions: T[],
  selected: string | null,
): T[] {
  if (!prev) return [];
  return sessions.filter(
    (s) => s.sessionId !== selected && (s.pendingRequests ?? 0) > (prev.get(s.sessionId) ?? 0),
  );
}

export const pendingSnapshot = (sessions: { sessionId: string; pendingRequests?: number }[]) =>
  new Map(sessions.map((s) => [s.sessionId, s.pendingRequests ?? 0]));
