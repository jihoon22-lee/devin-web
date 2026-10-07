import { NextRequest, NextResponse } from "next/server";
import { terminalPool } from "@/lib/acp/terminal";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { cols, rows, c, claim } = (await req.json()) as {
    cols?: number;
    rows?: number;
    c?: string;
    claim?: boolean;
  };
  if (!cols || !rows || cols < 1 || rows < 1)
    return NextResponse.json({ error: "cols/rows required" }, { status: 400 });
  if (claim && c) await terminalPool.claimResize(id, c);
  await terminalPool.resize(id, cols, rows, c);
  return NextResponse.json({ resized: true });
}
