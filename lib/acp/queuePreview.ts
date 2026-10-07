/** Queue previews and sizing — pure helpers split out of SessionManager.
 *
 *  A prompt waiting for the running turn to finish keeps a stable `id`
 *  while the queue shifts, so the UI can edit/drop exactly this entry. The
 *  queue itself is persisted (lib/promptQueue.ts) — a web restart used to
 *  drop it silently while the daemon mirror kept replaying the stale
 *  `queued:1` session_state as an undeletable ghost. */
import type { ContentBlock } from "./types";
import type { QueuedPrompt } from "../promptQueue";
import { mentionPath } from "./mentionUri";

/** First line of concatenated text blocks — a compact queue preview. */
export function queueText(blocks: ContentBlock[]): string {
  const text = blocks
    .map((b) => (b.type === "text" ? b.text : b.type === "resource_link" ? `@${(b as { name?: string }).name ?? "file"}` : "[attachment]"))
    .join(" ")
    .trim();
  return text.split("\n")[0].slice(0, 120);
}

/** Serialized-size estimate of prompt blocks — string field lengths only.
 *  `.length` is O(1) per string, so this stays cheap even with 50MB of
 *  base64 parked (a JSON.stringify pass would cost the very stall the cap
 *  is meant to bound). */
export function blocksBytes(blocks: ContentBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    n += 64; // JSON framing + small fields
    switch (b.type) {
      case "text": n += b.text.length; break;
      case "image":
      case "audio": n += b.data.length; break;
      case "resource_link": n += b.uri.length + b.name.length; break;
      case "resource":
        n += b.resource.uri.length + (b.resource.text?.length ?? 0) + (b.resource.blob?.length ?? 0);
        break;
    }
  }
  return n;
}

/** Only URI-encoded prompts may be decoded for display. Old persisted
 *  queues contain literal paths, including literal %20. */
export function displayMentions(blocks: ContentBlock[], encoding?: "uri") {
  return blocks
    .filter((b) => b.type === "resource_link")
    .map((b) => ({
      path: typeof (b as { uri?: unknown }).uri === "string"
        ? encoding === "uri"
          ? mentionPath((b as { uri: string }).uri)
          : (b as { uri: string }).uri.replace(/^file:\/\//, "")
        : "",
      name: typeof (b as { name?: unknown }).name === "string" ? (b as { name: string }).name : "",
    }))
    .filter((m) => m.path);
}

/** Status-bar previews of the queue, addressable by id. Mentions and the
 *  attachment count ride along so ghost bubbles show what was attached —
 *  a text-only preview hid images and file mentions until drain. */
export function queueView(s: { queue: QueuedPrompt[] }) {
  return s.queue.map((q) => ({
    id: q.id,
    text: queueText(q.blocks),
    mentions: displayMentions(q.blocks, q.mentionEncoding),
    attachments: q.blocks.filter((b) => b.type !== "text" && b.type !== "resource_link").length,
  }));
}
