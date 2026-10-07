import { NextResponse } from "next/server";
import { manager } from "@/lib/state";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { clearQueue?: boolean };
  manager().cancel(id, { clearQueue: body.clearQueue === true });
  return NextResponse.json({ ok: true });
}
