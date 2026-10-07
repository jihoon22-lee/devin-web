import { NextResponse } from "next/server";
import { sendPush } from "@/lib/push";

export const dynamic = "force-dynamic";

/** POST /api/push/test — send a test notification to every device. */
export async function POST() {
  const sent = await sendPush({ title: "devin-web", body: "Push notifications are on", url: "", tag: "dw-test" });
  return NextResponse.json({ sent });
}
