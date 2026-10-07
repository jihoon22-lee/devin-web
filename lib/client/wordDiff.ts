/** Word-level highlighting for a removed/added line pair — the part of a
 *  long line that actually changed is otherwise a needle in a red/green
 *  haystack, worst on a narrow phone screen. LCS over word tokens; lines
 *  past the token cap fall back to whole-line marking. */
export interface Seg {
  text: string;
  changed: boolean;
}

const MAX_TOKENS = 400;

const tokenize = (s: string) => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];

function merge(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.changed === s.changed) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

export function wordDiff(a: string, b: string): { a: Seg[]; b: Seg[] } {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length > MAX_TOKENS || tb.length > MAX_TOKENS) {
    return { a: [{ text: a, changed: true }], b: [{ text: b, changed: true }] };
  }
  // dp[i][j] = LCS length of ta[i..] and tb[j..]
  const dp: Uint16Array[] = Array.from({ length: ta.length + 1 }, () => new Uint16Array(tb.length + 1));
  for (let i = ta.length - 1; i >= 0; i--) {
    for (let j = tb.length - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const sa: Seg[] = [];
  const sb: Seg[] = [];
  let i = 0;
  let j = 0;
  while (i < ta.length && j < tb.length) {
    if (ta[i] === tb[j]) {
      sa.push({ text: ta[i++], changed: false });
      sb.push({ text: tb[j++], changed: false });
    } else if (dp[i + 1][j] >= dp[i][j + 1]) sa.push({ text: ta[i++], changed: true });
    else sb.push({ text: tb[j++], changed: true });
  }
  while (i < ta.length) sa.push({ text: ta[i++], changed: true });
  while (j < tb.length) sb.push({ text: tb[j++], changed: true });
  // whitespace-only "changes" between unchanged words read as noise
  for (const s of [...sa, ...sb]) if (s.changed && !s.text.trim()) s.changed = false;
  return { a: merge(sa), b: merge(sb) };
}

export interface DiffLine {
  /** raw line incl. its +/-/space prefix */
  raw: string;
  type: "add" | "del" | "ctx" | "hunk" | "meta";
  oldNo?: number;
  newNo?: number;
  /** word-level segments of the content (no prefix) for paired lines */
  segs?: Seg[];
}

/** Number the lines from hunk headers and pair each run of removals with
 *  the run of additions that follows it for word-level highlighting. */
export function annotateHunks(lines: string[]): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0;
  let n = 0;
  for (const raw of lines) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      out.push({ raw, type: "hunk" });
    } else if (raw.startsWith("+")) out.push({ raw, type: "add", newNo: n++ });
    else if (raw.startsWith("-")) out.push({ raw, type: "del", oldNo: o++ });
    else if (raw.startsWith(" ") || raw === "") out.push({ raw, type: "ctx", oldNo: o++, newNo: n++ });
    else out.push({ raw, type: "meta" });
  }
  for (let i = 0; i < out.length; ) {
    if (out[i].type !== "del") {
      i++;
      continue;
    }
    let d = i;
    while (d < out.length && out[d].type === "del") d++;
    let a = d;
    while (a < out.length && out[a].type === "add") a++;
    const pairs = Math.min(d - i, a - d);
    for (let k = 0; k < pairs; k++) {
      const w = wordDiff(out[i + k].raw.slice(1), out[d + k].raw.slice(1));
      out[i + k].segs = w.a;
      out[d + k].segs = w.b;
    }
    i = a;
  }
  return out;
}
