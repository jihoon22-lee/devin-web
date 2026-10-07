import { NextRequest, NextResponse } from "next/server";
import { sessionTags, setSessionTags } from "@/lib/tags";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/sessions/:id/tags → {tags: string[]} */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  return NextResponse.json({ tags: sessionTags(id) });
}

/** PUT /api/sessions/:id/tags {tags: string[]} — replace the tag list. */
export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { tags } = (await req.json()) as { tags?: unknown };
    const stored = setSessionTags(id, tags);
    if (stored === null) {
      return NextResponse.json({ error: "invalid tags" }, { status: 400 });
    }
    return NextResponse.json({ tags: stored });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
