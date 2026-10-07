import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// db.ts binds the CLI path at import time. Keep both databases isolated from
// the live server, then import the actual itemlog and manager implementations.
const cliDir = mkdtempSync(join(tmpdir(), "dw-rr-cli-"));
const stateDir = mkdtempSync(join(tmpdir(), "dw-rr-state-"));
process.env.DEVIN_CLI_DIR = cliDir;
process.env.DEVIN_WEB_STATE_DIR = stateDir;
afterAll(() => {
  rmSync(cliDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

const { DatabaseSync } = await import("node:sqlite");
const sdb = new DatabaseSync(join(cliDir, "sessions.db"));
sdb.exec(`CREATE TABLE tool_call_state(
  session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
  tool_call_json TEXT, tool_call_update_json TEXT,
  PRIMARY KEY (session_id, tool_call_id))`);
const insert = sdb.prepare("INSERT INTO tool_call_state VALUES (?,?,?,?)");
for (const [id, status] of [
  ["call-done", "completed"],
  ["call-failed", "failed"],
  ["call-live", "in_progress"],
  ["call-already-done", "failed"],
]) {
  insert.run("s1", id, JSON.stringify({ toolCallId: id, status: "in_progress" }),
    JSON.stringify({ status, content: [{ type: "content", text: `${id} result` }] }));
}
sdb.close();

const { itemLogSave } = await import("../lib/itemLog");
const { itemRev } = await import("../lib/acp/itemAssembler");
const { SessionManager } = await import("../lib/acp/manager");

describe("restore reconciles DB-final tools (D V4-3)", () => {
  it("updates only restored open tools with terminal DB rows in place and advances their revisions", () => {
    const saved = [
      { id: "p-tX-1-0", kind: "tool" as const, tool: { toolCallId: "call-done", title: "done title", status: "in_progress" }, done: false, seqFrom: 41, seqTo: 50 },
      { id: "p-tX-1-1", kind: "tool" as const, tool: { toolCallId: "call-failed", title: "failed title", status: "in_progress" }, done: false, seqFrom: 42, seqTo: 51 },
      { id: "p-tX-1-2", kind: "tool" as const, tool: { toolCallId: "call-live", title: "live title", status: "in_progress" }, done: false, seqFrom: 43, seqTo: 52 },
      { id: "p-tX-1-3", kind: "tool" as const, tool: { toolCallId: "call-already-done", title: "already done title", status: "completed" }, done: false, seqFrom: 44, seqTo: 53 },
      { id: "p-tX-1-4", kind: "tool" as const, tool: { toolCallId: "call-missing", title: "missing title", status: "in_progress" }, done: false, seqFrom: 45, seqTo: 54 },
    ];
    itemLogSave("s1", "tX-1", 50, saved, false);

    const manager = new SessionManager(); // first read simulates a new web process
    const restored = manager.provisional("s1");
    expect(restored.map((i) => i.id)).toEqual(saved.map((i) => i.id));
    expect(restored.map((i) => i.tool?.toolCallId)).toEqual(saved.map((i) => i.tool.toolCallId));

    for (const [index, status] of [[0, "completed"], [1, "failed"]] as const) {
      expect(restored[index].tool).toMatchObject({
        toolCallId: saved[index].tool.toolCallId,
        title: saved[index].tool.title,
        status,
        content: [{ type: "content", text: `${saved[index].tool.toolCallId} result` }],
      });
      expect(restored[index].seqTo).toBeGreaterThan(saved[index].seqTo);
      expect(itemRev(restored[index])).not.toBe(itemRev(saved[index]));
    }
    for (const index of [2, 3, 4]) {
      expect(restored[index].tool).toEqual(saved[index].tool);
      expect(itemRev(restored[index])).toBe(itemRev(saved[index]));
    }
    expect(manager.provisional("s1")).toEqual(restored); // one-shot restore
  });
});
