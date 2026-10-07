import { NextResponse } from "next/server";
import { usageSeries } from "@/lib/searchIndex";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/usage/:id — per-response token series for one session (newest 500). */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return NextResponse.json({ series: usageSeries(id) });
}
