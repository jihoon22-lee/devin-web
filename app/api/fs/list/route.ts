import { NextRequest, NextResponse } from "next/server";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fsPathAllowed } from "@/lib/fsRoots";

export const dynamic = "force-dynamic";

/** GET /api/fs/list?path= — directory listing for explorer / directory picker */
export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get("path") || homedir();
    const path = resolve(raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw);
    if (!fsPathAllowed(path))
      return NextResponse.json({ error: "path outside DEVIN_WEB_FS_ROOTS" }, { status: 403 });
    const entries = await readdir(path, { withFileTypes: true });
    const items = entries
      .map((e) => ({
        name: e.name,
        path: join(path, e.name),
        type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "link" : "file",
      }))
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
      );
    const st = await stat(path);
    return NextResponse.json({ path, parent: resolve(path, ".."), items, mtime: st.mtimeMs });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
