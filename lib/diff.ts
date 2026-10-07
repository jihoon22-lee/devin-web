/** Minimal LCS line diff for tool-call old/new rendering. */

export interface DiffRow {
  type: "same" | "add" | "del" | "fold";
  text: string;
  /** fold rows carry the number of hidden identical lines */
  folded?: number;
}

/** Classic LCS line diff. For big inputs (>1500 lines) falls back to
 *  "delete all + add all" to stay O(n) instead of O(n·m). The absolute caps
 *  matter too: the product guard alone lets a 300k-line file × 5-line edit
 *  through, which still allocates a huge dp matrix. */
export function lineDiff(oldText: string | null, newText: string): DiffRow[] {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText ? newText.split("\n") : [];
  if (a.length > 5000 || b.length > 5000 || a.length * b.length > 1500 * 1500) {
    return [
      ...a.map((t): DiffRow => ({ type: "del", text: t })),
      ...b.map((t): DiffRow => ({ type: "add", text: t })),
    ];
  }
  // dp[i][j] = LCS length of a[i:] vs b[j:]
  const dp: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i++] });
    } else {
      rows.push({ type: "add", text: b[j++] });
    }
  }
  while (i < a.length) rows.push({ type: "del", text: a[i++] });
  while (j < b.length) rows.push({ type: "add", text: b[j++] });
  return rows;
}

/** Collapse long runs of unchanged lines: keep `ctx` lines around each change. */
export function foldContext(rows: DiffRow[], ctx = 3): DiffRow[] {
  const out: DiffRow[] = [];
  let runStart = -1;
  const flush = (end: number) => {
    if (runStart < 0) return;
    const runLen = end - runStart;
    const keepHead = runStart === 0 ? 0 : ctx; // no need for leading context at file start
    const keepTail = end === rows.length ? 0 : ctx;
    if (runLen > keepHead + keepTail + 2) {
      out.push(...rows.slice(runStart, runStart + keepHead));
      out.push({ type: "fold", text: "", folded: runLen - keepHead - keepTail });
      out.push(...rows.slice(end - keepTail, end));
    } else {
      out.push(...rows.slice(runStart, end));
    }
    runStart = -1;
  };
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type === "same") {
      if (runStart < 0) runStart = i;
    } else {
      flush(i);
      out.push(rows[i]);
    }
  }
  flush(rows.length);
  return out;
}
