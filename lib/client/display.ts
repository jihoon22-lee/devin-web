/** Display-only text helpers shared by the sidebar, welcome dashboard,
 *  header and palette. Never feed their output back into an API call. */

/** `/home/<user>/…`, `/Users/<user>/…` and `/root/…` read as `~/…`. */
export function tildePath(p: string): string {
  return p.replace(/^(?:\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/, "~");
}

/** Session titles come from the CLI, which sometimes derives them from the
 *  first assistant output: raw markdown (`**평가**:`) or a leaked tool call
 *  (`functions.shell:0{"command": …}`). Clean them for display only. */
export function displayTitle(title: string | null | undefined, fallback: string): string {
  const t = (title ?? "").trim();
  if (!t) return fallback;
  const leak = /^functions\.[\w.-]+:\d+\s*\{/.test(t) || /^\{\s*"(?:command|cmd|description)"/.test(t);
  if (leak) {
    const field = (k: string) => new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)+)`).exec(t)?.[1];
    const what = field("description") ?? field("command") ?? field("cmd");
    return what ? `⚙ ${what.replace(/\\"/g, '"')}` : "Untitled session";
  }
  const clean = t
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images → their text
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*>]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean || fallback;
}
