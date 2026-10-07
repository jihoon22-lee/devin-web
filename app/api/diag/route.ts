import { NextResponse } from "next/server";
import { noteIntegrityBeacon } from "@/lib/integrityBeacon";

export const dynamic = "force-dynamic";

// diagnostics share a process-wide token bucket — a misbehaving page (or a
// flood of reconnecting tabs) must not write server.log thousands of times
// a minute. Over the limit the POST is a quiet 204-style ok.
const WINDOW_MS = 60_000;
const BUDGET = 240;
let windowStart = Date.now();
let used = 0;

function diagAllowed(): boolean {
  const now = Date.now();
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now;
    used = 0;
  }
  return ++used <= BUDGET;
}

/** POST /api/diag — client-side diagnostic breadcrumbs (page lifecycle, JS
 *  errors, SSE state, transcript integrity). Logged server-side so mobile
 *  failures that never reach the dev tools can be correlated. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || !diagAllowed()) return NextResponse.json({ ok: true });
  const line = JSON.stringify(b);
  if (b.t === "integrity") {
    // its own prefix + counter: this one means a rendering regression,
    // not a page event — /api/health surfaces it via integrityCount()
    noteIntegrityBeacon(line.slice(0, 200));
    console.log(`[integrity] ${new Date().toISOString()} ${line.slice(0, 600)}`);
  } else {
    console.log(`[diag] ${new Date().toISOString()} ${line.slice(0, 400)}`);
  }
  return NextResponse.json({ ok: true });
}
