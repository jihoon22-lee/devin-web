import { NextRequest, NextResponse } from "next/server";
import { openSessionsDb } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Prior prompts for ↑-arrow history in the composer. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const db = openSessionsDb();
    try {
      const rows = db
        .prepare(
          "SELECT content FROM prompt_history WHERE session_id = ? AND is_shell = 0 ORDER BY timestamp DESC LIMIT 100",
        )
        .all(id) as { content: string }[];
      return NextResponse.json({ prompts: rows.map((r) => r.content) });
    } finally {
      db.close();
    }
  } catch {
    return NextResponse.json({ prompts: [] });
  }
}
