/** Spine↔durable alignment — pure functions, no I/O.
 *
 *  At turn flip (durable coverage confirmed) the provisional region is
 *  retired: spine items (user/agent text, tool calls) are superseded by
 *  their durable twins and dropped, while counterpart-less items (thoughts,
 *  plans) are RETAINED with an anchor = the node_id of the spine row they
 *  followed. This file computes both halves of that mapping.
 *
 *  Matching rules are structural only — `tool_call_id` exact match and
 *  per-role ordinal matching. Never compare text: the CLI may merge, split,
 *  or re-anchor messages, and text equality is not identity (AGENTS.md).
 *  A monotonic cursor guarantees order can never invert even when a row
 *  is missing on either side.
 */
import type { AssembledItem } from "./itemAssembler";

/** A durable transcript row reduced to what alignment needs. The caller
 *  maps sessions.db roles into assembler space (assistant → agent). */
export interface DurableSpineRow {
  nodeId: number;
  role: "user" | "agent" | "tool";
  toolCallId?: string;
}

const isSpine = (i: AssembledItem): boolean =>
  (i.kind === "text" && (i.role === "user" || i.role === "agent")) ||
  i.kind === "tool";

/** Items that outlive their turn — everything else is either spine
 *  (durable covers it) or overlay/ephemeral (requests, notices). */
export const isRetainable = (i: AssembledItem): boolean =>
  (i.kind === "text" && i.role === "thought") || i.kind === "plan";

/** Align spine items to durable rows, monotonically. Returns only the
 *  matches — an unaligned spine item is simply absent (its content never
 *  committed; it must not be retained either — see finalizeTurn). */
export function alignSpine(
  provItems: AssembledItem[],
  durableRows: DurableSpineRow[],
): Map<string, number> {
  const out = new Map<string, number>();
  let cursor = 0;
  for (const it of provItems) {
    if (!isSpine(it)) continue;
    for (let j = cursor; j < durableRows.length; j++) {
      const r = durableRows[j];
      const match =
        it.kind === "tool"
          ? r.role === "tool" && r.toolCallId === it.tool?.toolCallId
          : r.role === it.role;
      if (!match) continue;
      out.set(it.id, r.nodeId);
      cursor = j + 1;
      break;
    }
  }
  return out;
}

/** Anchor every retainable item to the last ALIGNED spine row before it
 *  (turnStartNode when none). Violating anchors — anything outside
 *  [turnStartNode, turnEndNode] — are clamped to turnStartNode and reported:
 *  an anchor past the turn's end is the retained form of the tail-clump
 *  bug, so the caller beacons rather than silently shipping it. */
export function computeAnchors(
  provItems: AssembledItem[],
  durableRows: DurableSpineRow[],
  turnStartNode: number,
  turnEndNode: number,
): { anchors: Map<string, number>; violations: string[] } {
  const aligned = alignSpine(provItems, durableRows);
  const anchors = new Map<string, number>();
  const violations: string[] = [];
  let last = turnStartNode;
  for (const it of provItems) {
    const a = aligned.get(it.id);
    if (a !== undefined) last = a;
    if (!isRetainable(it)) continue;
    if (last < turnStartNode || last > turnEndNode) {
      violations.push(it.id);
      anchors.set(it.id, turnStartNode);
    } else {
      anchors.set(it.id, last);
    }
  }
  return { anchors, violations };
}
