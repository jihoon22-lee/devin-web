import type { ChatItem } from "./model";

/** Search-result → transcript scroll plumbing. A hit carries the node's id
 *  (works in the read-only transcript view) and a normalized text prefix
 *  (provisional items have no node id yet). `n` is a
 *  nonce so re-picking the same hit re-triggers the scroll effect. */
export interface JumpTarget {
  nodeId?: number;
  anchor?: string;
  n: number;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Does this rendered message text correspond to the search hit? */
export function anchorMatch(text: string, anchor?: string): boolean {
  if (!anchor) return false;
  return norm(text).startsWith(anchor.slice(0, 40));
}

/** Searchable text of a live chat item — messages, plus tool output (a search
 *  hit on a tool row carries the tool output as its anchor). */
export function itemText(item: ChatItem): string {
  if (item.kind === "text") return item.text;
  if (item.kind !== "tool") return "";
  const parts: string[] = [];
  for (const c of item.tool.content ?? []) {
    if (c.type === "content" && c.content.type === "text") parts.push(c.content.text);
  }
  if (typeof item.tool.rawOutput === "string") parts.push(item.tool.rawOutput);
  return parts.join("\n");
}

const nodeOf = (i: ChatItem) => (i.id.startsWith("bf-") ? Number(i.id.slice(3)) : NaN);

/** Resolve a search hit to a rendered item. Durable rows carry their node
 *  id (`bf-<nodeId>`) — match it exactly; the text anchor is a fallback
 *  only when the target has no node id, and only against provisional items. Prefix matching on durable rows jumped to whichever message first
 *  shared the opening 40 characters. */
export function findJumpTarget(items: ChatItem[], jump: JumpTarget): ChatItem | undefined {
  if (jump.nodeId != null) {
    return items.find((i) => nodeOf(i) === jump.nodeId);
  }
  return items.find((i) => !i.id.startsWith("bf-") && anchorMatch(itemText(i), jump.anchor));
}

/** The hit's node lies above the loaded durable window and more history
 *  exists — page older rows in until it renders. */
export function needsOlderPageForJump(items: ChatItem[], jump: JumpTarget, historyTruncated: boolean): boolean {
  if (jump.nodeId == null || !historyTruncated) return false;
  const first = items.find((i) => i.id.startsWith("bf-"));
  return !!first && jump.nodeId < nodeOf(first);
}
