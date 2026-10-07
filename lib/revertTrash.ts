/** Safety net for the Changes tab's Revert (E1): the file's worktree bytes
 *  are copied aside BEFORE git discards them, so a mistaken revert can be
 *  undone. Worktree content only — the index (staged state) is not
 *  restored. $STATE_DIR/revert-trash, at most 50 entries / 24h. */
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { RevertConflictError } from "./gitChanges";
import { stateDir } from "./paths.mjs";
import { dirname, join, resolve, sep } from "node:path";

const trashDir = () => join(stateDir(), "revert-trash");
const MAX_ENTRIES = 50;
const MAX_AGE_MS = 24 * 3600e3;
const ID_RE = /^\d{13}-[0-9a-f]{12}$/;

export interface TrashMeta {
  cwd: string;
  file: string;
  at: number;
  /** false: the file was absent (a worktree delete) — undo removes it again */
  existed: boolean;
  version?: 2;
  files?: SavedFile[];
}

type SavedFile = { file: string } & (
  { kind: "absent" } | { kind: "symlink"; target: string } |
  { kind: "file"; content: string; mode: number }
);

function statOrMissing(path: string) {
  try { return lstatSync(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

/** Never follow a parent link introduced after the backup. Leaf links are
 * restored with rename, which replaces the link rather than its target. */
function safeDestination(cwd: string, file: string): string {
  const root = resolve(cwd);
  const dst = resolve(root, file);
  if (!file || file.startsWith("/") || file.split(/[\\/]/).includes("..") ||
      dst === root || !dst.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error("bad path");
  let parent = dirname(dst);
  while (parent !== root) {
    const st = statOrMissing(parent);
    if (st?.isSymbolicLink()) throw new Error("refusing a symlink parent during file recovery");
    if (st && !st.isDirectory()) throw new Error("recovery parent is not a directory");
    parent = dirname(parent);
  }
  return dst;
}

function saveFiles(cwd: string, paths: string[], dir: string): SavedFile[] {
  return paths.map((file, i) => {
    const src = safeDestination(cwd, file);
    const st = statOrMissing(src);
    if (!st) return { file, kind: "absent" };
    if (st.isSymbolicLink()) return { file, kind: "symlink", target: readlinkSync(src) };
    if (!st.isFile()) throw new Error("only files and symlinks can be reverted");
    const content = `content-${i}`;
    copyFileSync(src, join(dir, content));
    chmodSync(join(dir, content), 0o600);
    return { file, kind: "file", content, mode: st.mode & 0o777 };
  });
}

/** Same-path writes are not visible in porcelain status; compare the actual
 * bytes, type and permissions saved by this request before discarding them. */
export function assertBackupUnchanged(id: string, cwd: string): void {
  const dir = join(trashDir(), id);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as TrashMeta;
  if (resolve(meta.cwd) !== resolve(cwd) || !meta.files) throw new Error("invalid backup");
  for (const entry of meta.files) {
    const src = safeDestination(cwd, entry.file);
    const st = statOrMissing(src);
    const unchanged = entry.kind === "absent" ? !st
      : entry.kind === "symlink" ? st?.isSymbolicLink() && readlinkSync(src) === entry.target
      : st?.isFile() && (st.mode & 0o777) === entry.mode && readFileSync(src).equals(readFileSync(join(dir, entry.content)));
    if (!unchanged) throw new RevertConflictError("Worktree changed since the safety copy; refresh and try again. Nothing was discarded.");
  }
}

export function backupBeforeRevert(cwd: string, file: string, relatedFiles: string[] = []): string {
  const id = `${Date.now()}-${randomBytes(6).toString("hex")}`;
  const dir = join(trashDir(), id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const files = saveFiles(cwd, [...new Set([file, ...relatedFiles])], dir);
    const meta: TrashMeta = { cwd, file, at: Date.now(), existed: files[0].kind !== "absent", version: 2, files };
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e; // the route must not run git when the safety copy failed
  }
  pruneTrash();
  return id;
}

export function undoRevert(id: string, cwd: string): TrashMeta {
  if (!ID_RE.test(id)) throw new Error("bad undo id");
  const dir = join(trashDir(), id);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as TrashMeta;
  // the bytes go back into the SAME session tree they came from
  if (resolve(meta.cwd) !== resolve(cwd)) throw new Error("undo belongs to another session");
  const files: SavedFile[] = meta.version === 2 && Array.isArray(meta.files) ? meta.files : [
    meta.existed ? { file: meta.file, kind: "file", content: "content", mode: 0o600 } : { file: meta.file, kind: "absent" },
  ];
  const staged: { dst: string; tmp: string | null }[] = [];
  const changed: number[] = [];
  // Keep the pre-undo state separately from the original safety copy. If a
  // compensating write also fails, this manifest identifies every saved path.
  const recoveryDir = join(dir, `before-undo-${randomBytes(6).toString("hex")}`);
  mkdirSync(recoveryDir, { mode: 0o700 });
  let prior: SavedFile[] = [];
  const prepare = (entry: SavedFile, contentDir: string, legacy = false) => {
    const dst = safeDestination(cwd, entry.file);
    const st = statOrMissing(dst);
    if (st && !st.isFile() && !st.isSymbolicLink()) throw new Error("recovery destination is not a file");
    if (legacy && st?.isSymbolicLink()) throw new Error("legacy backup cannot safely restore a symlink");
    if (entry.kind === "absent") return { dst, tmp: null };
    mkdirSync(dirname(dst), { recursive: true });
    const tmp = join(dirname(dst), `.devin-undo-${randomBytes(12).toString("hex")}`);
    try {
      if (entry.kind === "symlink") symlinkSync(entry.target, tmp);
      else if (entry.kind === "file" && /^(content|content-\d+)$/.test(entry.content)) {
        copyFileSync(join(contentDir, entry.content), tmp);
        chmodSync(tmp, legacy ? (st?.mode ?? 0o600) & 0o777 : entry.mode & 0o777);
      } else throw new Error("invalid recovery metadata");
      return { dst, tmp };
    } catch (e) { rmSync(tmp, { force: true }); throw e; }
  };
  const apply = (entry: { dst: string; tmp: string | null }) => {
    if (entry.tmp) renameSync(entry.tmp, entry.dst);
    else rmSync(entry.dst, { force: true });
  };
  try {
    prior = saveFiles(cwd, files.map((entry) => entry.file), recoveryDir);
    writeFileSync(join(recoveryDir, "meta.json"), JSON.stringify({ cwd, file: meta.file, version: 2, files: prior }), { mode: 0o600 });
    for (const entry of files) staged.push(prepare(entry, dir, meta.version !== 2));
    for (let i = 0; i < staged.length; i++) {
      apply(staged[i]);
      changed.push(i);
    }
  } catch (e) {
    const failures: string[] = [];
    for (const i of changed.reverse()) {
      let rollback: ReturnType<typeof prepare> | undefined;
      try { rollback = prepare(prior[i], recoveryDir); apply(rollback); }
      catch (restoreError) { failures.push(`${prior[i].file}: ${(restoreError as Error).message}`); }
      finally { if (rollback?.tmp) rmSync(rollback.tmp, { force: true }); }
    }
    if (failures.length) {
      throw new Error(`${(e as Error).message}; rollback also failed (${failures.join("; ")}). Pre-undo recovery retained at ${recoveryDir}; original backup retained at ${dir}`);
    }
    throw e; // original safety copy and pre-undo recovery remain for retry
  } finally {
    for (const entry of staged) if (entry.tmp) rmSync(entry.tmp, { force: true });
  }
  rmSync(dir, { recursive: true, force: true });
  return meta;
}

export function pruneTrash(now = Date.now()) {
  let ids: string[];
  try {
    ids = readdirSync(trashDir()).filter((n) => ID_RE.test(n)).sort(); // oldest first
  } catch {
    return; // nothing backed up yet
  }
  const fresh = ids.filter((n) => now - Number(n.split("-")[0]) <= MAX_AGE_MS);
  const drop = new Set([
    ...ids.filter((n) => !fresh.includes(n)),
    ...fresh.slice(0, Math.max(0, fresh.length - MAX_ENTRIES)),
  ]);
  for (const n of drop) rmSync(join(trashDir(), n), { recursive: true, force: true });
}
