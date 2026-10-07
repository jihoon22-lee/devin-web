import { NextRequest, NextResponse } from "next/server";
import { terminalPool } from "@/lib/acp/terminal";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE /api/terminals/:id — the user closed the tab: kill it and hide it */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  await terminalPool.dismiss(id);
  return NextResponse.json({ ok: true });
}

/** PATCH /api/terminals/:id {keep} — pin a user shell against idle reaping */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { keep?: unknown } | null;
  if (typeof body?.keep !== "boolean") return NextResponse.json({ error: "keep must be boolean" }, { status: 400 });
  try {
    await terminalPool.setKeep(id, body.keep);
    return NextResponse.json({ ok: true });
  } catch (e) {
    // a daemon older than this build answers "unknown host method"
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
