import { NextRequest, NextResponse } from "next/server";
import { manager } from "@/lib/state";
import { PROMPT_MAX_IMAGE_BYTES, PROMPT_MAX_TOTAL_BYTES } from "@/lib/limits";
import { mentionUri } from "@/lib/acp/mentionUri";
import type { ContentBlock } from "@/lib/acp/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/sessions/:id/prompt — {text, images?, mentions?: [{path,name}]} */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    let body: {
      text?: string;
      images?: { data: string; mimeType: string }[];
      mentions?: { path: string; name?: string }[];
    };
    try {
      body = await req.json();
    } catch {
      // a body past the proxy buffer arrives truncated and fails JSON.parse —
      // say that instead of leaking "Unterminated string in JSON at …"
      return NextResponse.json({ error: "request body too large or malformed" }, { status: 413 });
    }
    const blocks: ContentBlock[] = [];
    for (const m of body.mentions ?? []) {
      blocks.push({
        type: "resource_link",
        uri: mentionUri(m.path),
        name: m.name ?? m.path.split("/").pop() ?? m.path,
      });
    }
    if (body.text) blocks.push({ type: "text", text: body.text });
    // base64 inflates ~4/3 — cap per-image and total so a paste can't turn
    // into a multi-hundred-MB prompt body (caps shared with lib/limits.ts)
    let total = 0;
    for (const img of body.images ?? []) {
      const est = Math.floor((img.data?.length ?? 0) * 0.75);
      if (est > PROMPT_MAX_IMAGE_BYTES) {
        return NextResponse.json(
          { error: `image exceeds ${PROMPT_MAX_IMAGE_BYTES / 1048576}MB` },
          { status: 413 },
        );
      }
      total += est;
      if (total > PROMPT_MAX_TOTAL_BYTES) {
        return NextResponse.json(
          { error: `images exceed ${PROMPT_MAX_TOTAL_BYTES / 1048576}MB total` },
          { status: 413 },
        );
      }
      blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    if (blocks.length === 0)
      return NextResponse.json({ error: "empty prompt" }, { status: 400 });
    const res = await manager().prompt(id, blocks);
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
