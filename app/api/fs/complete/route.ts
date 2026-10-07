import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fsPathAllowed } from "@/lib/fsRoots";

export const dynamic = "force-dynamic";

const execFileP = promisify(execFile);
const SKIP = new Set([".git", "node_modules", ".next", "dist", "build", ".cache", "__pycache__"]);
const MAX_FILES = 5000;
const MAX_DEPTH = 8;

interface Candidate {
  path: string; // relative to cwd
  name: string;
  isDir: boolean;
}

async function listFiles(cwd: string): Promise<Candidate[]> {
  try {
    const { stdout } = await execFileP(
      "rg",
      ["--files", "--hidden", "-g", "!.git", "-g", "!node_modules", "-g", "!.next", "--max-filesize", "10M"],
      { cwd, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, MAX_FILES)
      .map((p) => ({ path: p, name: p.split("/").pop()!, isDir: false }));
  } catch {
    /* rg missing or not a repo — walk */
  }
  // async breadth-first walk — the sync recursion it replaced stalled the
  // whole event loop (every live stream) on a big home dir
  const out: Candidate[] = [];
  const queue: [string, number][] = [[cwd, 0]];
  while (queue.length && out.length < MAX_FILES) {
    const [dir, depth] = queue.shift()!;
    if (depth > MAX_DEPTH) continue;
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      const rel = relative(cwd, full);
      out.push({ path: rel, name: e.name, isDir: e.isDirectory() });
      if (e.isDirectory() && out.length < MAX_FILES) queue.push([full, depth + 1]);
      if (out.length >= MAX_FILES) break;
    }
  }
  return out;
}

/** Mention keystrokes hit this route per character — a full rg scan every
 *  keystroke is a fork+scan storm. Cache the (unfiltered) listing per cwd
 *  briefly; staleness here just means a brand-new file won't complete for
 *  a few seconds. */
const LIST_TTL = 8_000;
/** One entry per cwd ever completed against, each holding up to MAX_FILES
 *  candidates — unbounded, this retains every project directory the user has
 *  ever typed `@` in for the life of the process. Evict expired entries and
 *  cap the map; both are cheap next to the rg scan they guard. */
const LIST_CACHE_MAX = 32;
const listCache = new Map<string, { at: number; files: Candidate[] | Promise<Candidate[]> }>();

function listFilesCached(cwd: string): Promise<Candidate[]> {
  const now = Date.now();
  const hit = listCache.get(cwd);
  if (hit && now - hit.at < LIST_TTL) return Promise.resolve(hit.files);
  for (const [k, v] of listCache) if (now - v.at >= LIST_TTL) listCache.delete(k);
  // still over budget (many live cwds) → drop the oldest insertions
  while (listCache.size >= LIST_CACHE_MAX) {
    const oldest = listCache.keys().next();
    if (oldest.done) break;
    listCache.delete(oldest.value);
  }
  const files = listFiles(cwd);
  // a rejected scan must not be served for the rest of the TTL
  const entry = { at: now, files };
  listCache.set(cwd, entry);
  void files.catch(() => listCache.delete(cwd));
  return files;
}

export function rankMatches(cands: Candidate[], q: string): Candidate[] {
  const lq = q.toLowerCase();
  const score = (c: Candidate) => {
    const p = c.path.toLowerCase();
    const n = c.name.toLowerCase();
    if (n === lq || p === lq) return 0;
    if (n.startsWith(lq)) return 1;
    if (p.startsWith(lq)) return 2;
    if (n.includes(lq)) return 3;
    if (p.includes(lq)) return 4;
    return -1;
  };
  return cands
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.c.path.length - b.c.path.length)
    .slice(0, 20)
    .map((x) => x.c);
}

/** GET /api/fs/complete?cwd=&q= — path completion for @-mentions */
export async function GET(req: NextRequest) {
  try {
    const cwd = resolve(req.nextUrl.searchParams.get("cwd") || process.env.HOME || "/");
    if (!fsPathAllowed(cwd))
      return NextResponse.json({ error: "path outside DEVIN_WEB_FS_ROOTS" }, { status: 403 });
    const st = await stat(cwd).catch(() => null);
    if (!st?.isDirectory()) {
      return NextResponse.json({ error: "not a directory" }, { status: 400 });
    }
    const q = req.nextUrl.searchParams.get("q") ?? "";
    const files = await listFilesCached(cwd);
    return NextResponse.json({ files: rankMatches(files, q) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
