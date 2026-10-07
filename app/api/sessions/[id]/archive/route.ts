import { NextRequest, NextResponse } from "next/server";
import { isArchived, setArchived } from "@/lib/archive";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/sessions/:id/archive → {archived: boolean} */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  return NextResponse.json({ archived: isArchived(id) });
}

/** PUT /api/sessions/:id/archive {archived: boolean} — archive or restore. */
export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { archived } = (await req.json()) as { archived?: unknown };
    const ok = setArchived(id, archived as boolean);
    if (ok === null) {
      return NextResponse.json({ error: "invalid archived flag" }, { status: 400 });
    }
    return NextResponse.json({ archived: isArchived(id) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
