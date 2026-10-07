import { NextResponse } from "next/server";
import { compactSearchIndex } from "@/lib/searchIndex";

export const dynamic = "force-dynamic";

/** POST /api/search/compact — rebuild the FTS postings tree + VACUUM the
 *  search.db file. The index is a rebuildable cache, so this is always
 *  safe; it blocks for a few seconds on large corpora. Used by
 *  `bin/devin-web-ctl search-compact`. */
export async function POST() {
  const ok = compactSearchIndex();
  return NextResponse.json({ ok }, { status: ok ? 200 : 500 });
}
