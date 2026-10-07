import { NextRequest, NextResponse } from "next/server";
import { addSub, listSubs, removeSub, vapidKeys } from "@/lib/push";

export const dynamic = "force-dynamic";

/** GET /api/push → {publicKey, devices} — the VAPID key a browser subscribes
 *  with, and how many devices are subscribed. */
export async function GET() {
  try {
    return NextResponse.json({ publicKey: vapidKeys().publicKey, devices: listSubs().length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** POST /api/push {subscription} — register this browser. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { subscription?: unknown } | null;
  if (!addSub(body?.subscription, req.headers.get("user-agent") ?? undefined)) {
    return NextResponse.json({ error: "invalid subscription" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, devices: listSubs().length });
}

/** DELETE /api/push {endpoint} — unregister one browser. */
export async function DELETE(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (typeof body?.endpoint !== "string") return NextResponse.json({ error: "endpoint required" }, { status: 400 });
  removeSub(body.endpoint);
  return NextResponse.json({ ok: true, devices: listSubs().length });
}
