import { NextRequest, NextResponse } from "next/server";
import { terminalPool } from "@/lib/acp/terminal";

export const dynamic = "force-dynamic";

/** GET /api/terminals?sessionId= — list live terminals */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId") || undefined;
  try {
    return NextResponse.json({ terminals: await terminalPool.list(sessionId) });
  } catch (e) {
    // host.sock down — answer JSON so the panel can show the reason
    return NextResponse.json({ error: (e as Error).message, terminals: [] }, { status: 503 });
  }
}

/** POST /api/terminals — spawn a user shell {cwd?} */
export async function POST(req: NextRequest) {
  try {
    const { cwd, sessionId } = (await req.json().catch(() => ({}))) as {
      cwd?: string;
      sessionId?: string;
    };
    const shell = process.env.SHELL || "/bin/bash";
    const res = await terminalPool.create(
      { sessionId: sessionId ?? "", command: shell, args: ["-l"], cwd: cwd || process.cwd(), env: [] },
      () => {},
      { user: true }, // user shells are idle-reaped; agent terminals aren't
    );
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
