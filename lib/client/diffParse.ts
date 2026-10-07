/** Split a `git diff` patch into per-file blocks and strip the envelope
 *  noise (`index`, mode lines, `---`/`+++` paths, binary markers) so the
 *  panel can render hunks instead of raw transport headers. */
export interface DiffFile {
  /** path from `diff --git a/x b/y` (the b/ side); "" for preamble text */
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  lines: string[];
}

const NOISE =
  /^(index |old mode |new mode |similarity index |rename from |rename to |GIT binary|Binary files )/;

export function parseGitDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  const push = () => {
    if (cur) files.push(cur);
    cur = null;
  };
  for (const l of patch.split("\n")) {
    // quoted paths carry spaces: diff --git "a/x y" "b/x y"
    const m =
      /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(l) ??
      /^diff --git (.+) (.+)$/.exec(l);
    if (m) {
      push();
      cur = { path: m[2] ?? m[1], isNew: false, isDeleted: false, lines: [] };
      continue;
    }
    if (!cur) cur = { path: "", isNew: false, isDeleted: false, lines: [] };
    if (l.startsWith("new file mode")) {
      cur.isNew = true;
      continue;
    }
    if (l.startsWith("deleted file mode")) {
      cur.isDeleted = true;
      continue;
    }
    if (l.startsWith("--- ") || l.startsWith("+++ ") || NOISE.test(l)) continue;
    cur.lines.push(l);
  }
  push();
  return files.filter((f) => f.path || f.lines.some((x) => x.trim()));
}
