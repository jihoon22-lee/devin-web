import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/db resolves DEVIN_CLI_DIR at import — set it before the dynamic import
const cliDir = mkdtempSync(join(tmpdir(), "dw-export-"));
process.env.DEVIN_CLI_DIR = cliDir;

const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(join(cliDir, "sessions.db"));
db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, working_directory TEXT NOT NULL,
  title TEXT, main_chain_id INTEGER, hidden INTEGER NOT NULL DEFAULT 0)`);
db.exec(`CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id))`);
db.exec("CREATE TABLE tool_call_state(session_id TEXT, tool_call_id TEXT, tool_call_json TEXT, tool_call_update_json TEXT)");
db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run("e1", "/tmp/e", "Export me", 2, 0);
const node = db.prepare(
  "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
);
node.run("e1", 1, null, JSON.stringify({ message_id: "u1", role: "user", content: "run ls" }), 1);
node.run("e1", 2, 1, JSON.stringify({
  message_id: "t1", role: "tool", content: "a.txt", tool_call_id: "tc1", metadata: { tool_name: "exec" },
}), 2);
db.prepare("INSERT INTO tool_call_state VALUES (?,?,?,?)").run(
  "e1", "tc1",
  JSON.stringify({ toolCallId: "tc1", title: "ls", kind: "execute" }),
  JSON.stringify({ status: "completed" }),
);
db.close();

const { GET } = await import("../app/api/sessions/[id]/export/route");

describe("export (L9)", () => {
  it("JSON export carries the merged tool-call state, not just its text", async () => {
    const res = await GET(new Request("http://x/api/sessions/e1/export?format=json"), {
      params: Promise.resolve({ id: "e1" }),
    });
    const body = (await res.json()) as { items: { role: string; tool?: unknown }[] };
    const tool = body.items.find((i) => i.role === "tool");
    expect(tool?.tool).toMatchObject({ toolCallId: "tc1", title: "ls", status: "completed" });
  });
});
