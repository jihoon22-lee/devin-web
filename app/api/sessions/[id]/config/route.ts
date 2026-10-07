import { NextRequest, NextResponse } from "next/server";
import { manager } from "@/lib/state";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/sessions/:id/config — {configId, value} via session/set_config_option */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "malformed JSON body" }, { status: 400 });
    }
    const { configId, value } = (body ?? {}) as { configId?: unknown; value?: unknown };
    if (typeof configId !== "string" || !configId)
      return NextResponse.json({ error: "configId must be a non-empty string" }, { status: 400 });
    if (typeof value !== "string" && typeof value !== "boolean")
      return NextResponse.json({ error: "value must be a string or boolean" }, { status: 400 });
    const res = await manager().setConfigOption(id, configId, value);
    return NextResponse.json(res ?? { ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
