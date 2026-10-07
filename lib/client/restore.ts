import type { ContentBlock } from "@/lib/acp/types";

export interface DraftParts {
  text: string;
  images: { data: string; mimeType: string; preview: string }[];
  mentions: { path: string; name: string }[];
}

/** Turn a queued prompt's ACP blocks back into composer state (text,
 *  attached images, @-mentions) so "edit" loses nothing. */
export function blocksToDraft(blocks: ContentBlock[]): DraftParts {
  const texts: string[] = [];
  const out: DraftParts = { text: "", images: [], mentions: [] };
  for (const b of blocks) {
    if (b.type === "text") texts.push(b.text);
    else if (b.type === "image") {
      out.images.push({ data: b.data, mimeType: b.mimeType, preview: `data:${b.mimeType};base64,${b.data}` });
    } else if (b.type === "resource_link") {
      out.mentions.push({ path: b.uri.replace(/^file:\/\//, ""), name: b.name });
    }
  }
  out.text = texts.join("\n");
  return out;
}

/** Put restored text below whatever the user is already typing. */
export function mergeDraftText(current: string, restored: string): string {
  if (!restored) return current;
  return current.trim() ? `${current}\n${restored}` : restored;
}
