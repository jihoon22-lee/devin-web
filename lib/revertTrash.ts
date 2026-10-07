/** Safety net for the Changes tab's Revert (E1): the file's worktree bytes
 *  are copied aside BEFORE git discards them, so a mistaken revert can be
 *  undone. Worktree content only — the index (staged state) is not
 *  restored. $STATE_DIR/revert-trash, at most 50 entries / 24h. */
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
}

export function backupBeforeRevert(cwd: string, file: string): string {
  const id = `${Date.now()}-${randomBytes(6).toString("hex")}`;
  const dir = join(trashDir(), id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const src = join(cwd, file);
  const existed = existsSync(src);
  if (existed) copyFileSync(src, join(dir, "content"));
  const meta: TrashMeta = { cwd, file, at: Date.now(), existed };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
  pruneTrash();
  return id;
}

export function undoRevert(id: string, cwd: string): TrashMeta {
  if (!ID_RE.test(id)) throw new Error("bad undo id");
  const dir = join(trashDir(), id);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as TrashMeta;
  // the bytes go back into the SAME session tree they came from
  if (resolve(meta.cwd) !== resolve(cwd)) throw new Error("undo belongs to another session");
  const dst = resolve(cwd, meta.file);
  if (!dst.startsWith(resolve(cwd) + sep)) throw new Error("bad path");
  if (meta.existed) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(dir, "content"), dst);
  } else {
    rmSync(dst, { force: true });
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
