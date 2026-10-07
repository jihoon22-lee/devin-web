import { NextResponse } from "next/server";
import { usageReport } from "@/lib/usage";

export const dynamic = "force-dynamic";

/** GET /api/usage — per-session token/cost totals + a 30-day daily series,
 *  aggregated from the search.db usage_rows cache (cached ~30s once the
 *  indexer reports complete; Server-Timing exposes the real cost). */
export async function GET() {
  const t0 = performance.now();
  const report = usageReport();
  return NextResponse.json(report, {
    headers: { "Server-Timing": `usage;dur=${(performance.now() - t0).toFixed(1)}` },
  });
}
