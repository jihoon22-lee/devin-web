import { NextRequest, NextResponse } from "next/server";
import { listAllowRules, revokeAllowRules } from "@/lib/devinPermissions";

export const dynamic = "force-dynamic";

/** GET /api/permissions → {allow} — the CLI's "allow always" rules. */
export async function GET() {
  const allow = listAllowRules();
  if (!allow) return NextResponse.json({ error: "devin config not readable" }, { status: 404 });
  return NextResponse.json({ allow });
}

/** DELETE /api/permissions {rules: string[]} — revoke rules. */
export async function DELETE(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { rules?: unknown } | null;
  const rules = body?.rules;
  if (!Array.isArray(rules) || !rules.length || rules.some((r) => typeof r !== "string") || rules.length > 500) {
    return NextResponse.json({ error: "rules must be a non-empty string list" }, { status: 400 });
  }
  const allow = revokeAllowRules(rules as string[]);
  if (!allow) return NextResponse.json({ error: "could not update the devin config" }, { status: 500 });
  return NextResponse.json({ allow });
}
