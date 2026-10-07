import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Hermetic sessions.db — lib/db binds SESSIONS_DB at import time, so env
// must be set before the (dynamic) import of lib/transcript-db.
const cliDir = mkdtempSync(join(tmpdir(), "dw-cli-"));
process.env.DEVIN_CLI_DIR = cliDir;
afterAll(() => rmSync(cliDir, { recursive: true, force: true }));

const { DatabaseSync } = await import("node:sqlite");
const sdb = new DatabaseSync(join(cliDir, "sessions.db"));
sdb.exec(`CREATE TABLE tool_call_state(
  session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
  tool_call_json TEXT, tool_call_update_json TEXT,
  PRIMARY KEY (session_id, tool_call_id))`);
const ins = sdb.prepare(
  "INSERT INTO tool_call_state(session_id, tool_call_id, tool_call_json, tool_call_update_json) VALUES (?,?,?,?)",
);
const call = { sessionUpdate: "tool_call", toolCallId: "x", status: "in_progress" };
ins.run("s1", "call-done", JSON.stringify(call), JSON.stringify({ status: "completed", content: [{ type: "content", text: "ok" }] }));
ins.run("s1", "call-failed", JSON.stringify(call), JSON.stringify({ status: "failed" }));
ins.run("s1", "call-live", JSON.stringify(call), JSON.stringify({ status: "in_progress" }));
ins.run("s1", "call-null", JSON.stringify(call), null);
sdb.close();

const { finalToolUpdates } = await import("../lib/transcript-db");

describe("finalToolUpdates", () => {
  it("returns terminal updates for db-finished calls, keyed by toolCallId", () => {
    const out = finalToolUpdates("s1", ["call-done", "call-failed"]);
    expect(out).toHaveLength(2);
    const done = out.find((u) => u.toolCallId === "call-done")!;
    expect(done).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
      content: [{ type: "content", text: "ok" }],
    });
    expect(out.find((u) => u.toolCallId === "call-failed")).toMatchObject({ status: "failed" });
  });

  it("skips calls that are still open or have no final update", () => {
    expect(finalToolUpdates("s1", ["call-live", "call-null"])).toEqual([]);
  });

  it("scopes rows to the session", () => {
    expect(finalToolUpdates("other-session", ["call-done"])).toEqual([]);
  });

  it("returns [] for an empty id list without opening the db", () => {
    expect(finalToolUpdates("s1", [])).toEqual([]);
  });
});
