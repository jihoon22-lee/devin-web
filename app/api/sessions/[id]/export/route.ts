import { NextResponse } from "next/server";
import { mainChainHead, mainChainRows, openSessionsDb } from "@/lib/db";
import { attachToolState, rowsToTranscript, type MessageNodeRow, type TranscriptItem } from "@/lib/transcript";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const ROLE_HEADING: Record<TranscriptItem["role"], string> = {
  user: "## User",
  assistant: "## Devin",
  tool: "### 🔧 tool",
  system: "## system",
};

function toMarkdown(sessionId: string, cwd: string, title: string | null, items: TranscriptItem[]): string {
  const head = [
    `# ${title || sessionId}`,
    "",
    `_${cwd}_`,
    `_exported ${new Date().toISOString()} · session \`${sessionId}\`_`,
    "",
  ];
  const body = items.flatMap((i) => {
    if (i.role === "tool") {
      // text may itself contain backticks — use a 4-backtick fence
      return [`### 🔧 ${i.toolName || "tool"}`, "", "````", i.text, "````", ""];
    }
    return [ROLE_HEADING[i.role], "", i.text, ""];
  });
  return [...head, ...body].join("\n");
}

/** GET /api/sessions/:id/export — download the transcript as markdown.
 *  `?format=json` returns the structured items for reprocessing. */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const format = new URL(req.url).searchParams.get("format");
  try {
    const db = openSessionsDb();
    try {
      const sess = db
        .prepare("SELECT title, working_directory FROM sessions WHERE id = ?")
        .get(id) as { title: string | null; working_directory: string } | undefined;
      // export wants the complete main chain — unbounded CTE walk (fork
      // branches are still skipped); legacy fallback scans everything
      const head = mainChainHead(db, id);
      const rows: MessageNodeRow[] =
        head != null
          ? mainChainRows(db, id, head, 1_000_000)
          : (db
              .prepare(
                "SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes WHERE session_id = ? ORDER BY node_id",
              )
              .all(id) as unknown as MessageNodeRow[]);
      const { items } = rowsToTranscript(rows, 100000);
      if (format === "json") {
        // structured export is for reprocessing — carry each tool card's merged
        // ToolCall + update state, not just its flattened text
        attachToolState(db, id, items);
        return new NextResponse(
          JSON.stringify(
            {
              sessionId: id,
              title: sess?.title ?? null,
              cwd: sess?.working_directory ?? "",
              exportedAt: new Date().toISOString(),
              items,
            },
            null,
            2,
          ),
          {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Content-Disposition": `attachment; filename="${id}.json"`,
            },
          },
        );
      }
      const md = toMarkdown(id, sess?.working_directory ?? "", sess?.title ?? null, items);
      return new NextResponse(md, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${id}.md"`,
        },
      });
    } finally {
      db.close();
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
