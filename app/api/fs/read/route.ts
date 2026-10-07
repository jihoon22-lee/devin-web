import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fsPathAllowed } from "@/lib/fsRoots";

export const dynamic = "force-dynamic";

const MAX = 1024 * 1024; // 1MB

/** GET /api/fs/read?path= — file content (text or base64 for binary) */
export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get("path") || "";
    const path = resolve(raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw);
    if (!fsPathAllowed(path))
      return NextResponse.json({ error: "path outside DEVIN_WEB_FS_ROOTS" }, { status: 403 });
    const st = await stat(path);
    if (!st.isFile()) return NextResponse.json({ error: "not a file" }, { status: 400 });
    if (st.size > MAX)
      return NextResponse.json({ error: "file too large", size: st.size }, { status: 413 });
    const buf = await readFile(path);
    const binary = buf.includes(0);
    return NextResponse.json({
      path,
      size: st.size,
      encoding: binary ? "base64" : "utf8",
      content: binary ? buf.toString("base64") : buf.toString("utf8"),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
