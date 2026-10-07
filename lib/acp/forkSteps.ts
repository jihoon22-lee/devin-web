/** Pure step selection for fork-at-node — lifted out of SessionManager so
 *  the covering-step rule is testable without an ACP bridge. */

export interface ForkStep {
  forkTargetNodeId?: number | null;
}

/** The covering step for `nodeId` — the smallest fork anchor at-or-past the
 *  click keeps the clicked message in the clone; past the last anchor we
 *  take the newest step. The protocol does not promise step order, so the
 *  list is sorted ascending before the search. Returns null when nothing
 *  carries a fork anchor (session has no prompt steps yet). */
export function pickCoveringStep<S extends ForkStep>(steps: S[], nodeId: number): S | null {
  const sorted = steps
    .filter((s) => s.forkTargetNodeId != null)
    .sort((a, b) => (a.forkTargetNodeId as number) - (b.forkTargetNodeId as number));
  return (
    sorted.find((s) => (s.forkTargetNodeId as number) >= nodeId) ??
    sorted[sorted.length - 1] ??
    null
  );
}
