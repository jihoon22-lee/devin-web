/** Parse `@path` mention tokens out of prompt text. */

export interface MentionToken {
  /** The raw token text as typed, e.g. "@src/foo.ts" */
  token: string;
  /** Path portion without the @ */
  path: string;
  start: number;
  end: number;
}

const MENTION_RE = /(^|\s)@([^\s@]+)/g;

export function extractMentions(text: string): MentionToken[] {
  const out: MentionToken[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const at = m.index + m[1].length;
    out.push({ token: `@${m[2]}`, path: m[2], start: at, end: at + m[2].length + 1 });
  }
  return out;
}

/** Absolute mention path → path relative to cwd. Non-prefix paths (and
 *  siblings that merely share a string prefix, like cwd /tmp/x vs
 *  /tmp/x2/f) pass through unchanged; a trailing "/" on cwd is ignored. */
export function relMentionPath(cwd: string, abs: string): string {
  const base = cwd === "/" ? cwd : cwd.replace(/\/$/, "");
  return abs.startsWith(`${base}/`) ? abs.slice(base.length + 1) : abs;
}

/** The active (being-typed) mention at the caret, if any. */
export function activeMentionQuery(text: string, caret: number): { q: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { q: m[1], start: caret - m[1].length };
}
