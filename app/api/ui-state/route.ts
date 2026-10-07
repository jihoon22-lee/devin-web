import { NextRequest, NextResponse } from "next/server";
import { uiState, updateUiState } from "@/lib/uiState";

export const dynamic = "force-dynamic";

/** GET /api/ui-state → {pins, collapsed} */
export async function GET() {
  return NextResponse.json(uiState());
}

/** PUT /api/ui-state {pins?, collapsed?} — replace the given lists. */
export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const next = updateUiState(body);
  if (!next) return NextResponse.json({ error: "invalid ui state" }, { status: 400 });
  return NextResponse.json(next);
}
