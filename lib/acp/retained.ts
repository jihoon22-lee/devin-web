/** Retained-turn budget — ONE bound for memory (manager) and disk
 *  (itemLogPruneRetained), so a restarted process reloads exactly what the
 *  live one was showing. Pure module (client-safe types only). */
import type { AssembledItem } from "./itemAssembler";

export const RETAINED_TURNS = 20;

/** Assembled ids are `p-<turnId>-<n>`; the turn id itself contains dashes. */
export function turnKeyOf(itemId: string): string {
  return /^p-(.+)-\d+$/.exec(itemId)?.[1] ?? itemId;
}

/** Keep the newest `keep` turns (by first appearance order), order kept. */
export function capRetainedTurns(items: AssembledItem[], keep = RETAINED_TURNS): AssembledItem[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const k = turnKeyOf(it.id);
    if (!seen.has(k)) {
      seen.add(k);
      order.push(k);
    }
  }
  if (order.length <= keep) return items;
  const kept = new Set(order.slice(-keep));
  return items.filter((it) => kept.has(turnKeyOf(it.id)));
}
