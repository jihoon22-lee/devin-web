import { NextRequest, NextResponse } from "next/server";
import { terminalPool } from "@/lib/acp/terminal";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/terminals/:id/input — {data, c?: connId, seq?: number}
 *  connId+seq let the pool order/batch keystrokes per connection; plain
 *  {data} still works for unsequenced callers. */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { data, c, seq } = (await req.json()) as { data: string; c?: string; seq?: number };
    if (typeof data !== "string") {
      return NextResponse.json({ error: "data required" }, { status: 400 });
    }
    await terminalPool.write(id, data, c, seq);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
