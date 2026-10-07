import { NextRequest, NextResponse } from "next/server";
import { setConnVisible, subscribe, unsubscribe, type SubSpec } from "@/lib/stream/connections";

export const dynamic = "force-dynamic";

const KINDS = new Set(["global", "transcript", "terminal", "view"]);

/** POST /api/stream/subscribe — {connId, add?: SubSpec[], remove?: SubSpec[], visible?}
 *  changes the connection's subscription set without touching the socket. */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      connId?: string;
      add?: SubSpec[];
      remove?: SubSpec[];
      /** tab visibility change — gates push notifications */
      visible?: boolean;
    };
    // same bound as /api/stream — an oversized connId is rejected there too
    if (!body.connId || body.connId.length > 128) {
      return NextResponse.json({ error: "connId required (≤128 chars)" }, { status: 400 });
    }
    const ok = (s: SubSpec[]) => (s ?? []).filter((x) => x && KINDS.has(x.kind));
    if (body.remove?.length) unsubscribe(body.connId, ok(body.remove));
    if (body.add?.length) subscribe(body.connId, ok(body.add));
    if (typeof body.visible === "boolean") setConnVisible(body.connId, body.visible);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
