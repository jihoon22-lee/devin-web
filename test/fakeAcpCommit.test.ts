import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../lib/sqlite";

it("a scripted durable commit survives a concurrent transcript reader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dw-fake-commit-"));
  const file = join(dir, "sessions.db");
  const script = join(dir, "script.json");
  const db = openDb(file);
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, main_chain_id INTEGER);
    INSERT INTO sessions VALUES ('s', NULL);
    CREATE TABLE message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, created_at INTEGER);`);
  writeFileSync(script, JSON.stringify({ turns: [{ match: "probe", steps: [{ emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "commit-lock-probe" } } }, { commit: { role: "assistant", text: "durable reply" } }] }] }));
  const child = spawn(process.execPath, [resolve("test/fixtures/fake-acp.mjs")], {
    env: { ...process.env, FAKE_ACP_DB: file, FAKE_ACP_SCRIPT: script }, stdio: ["pipe", "pipe", "pipe"],
  });
  let locked = false;
  let unlock: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    db.exec("BEGIN");
    db.prepare("SELECT * FROM sessions").all();
    locked = true;
    const response = new Promise<void>((resolveReply, reject) => {
      let text = "";
      child.stdout.on("data", (chunk) => {
        text += chunk.toString();
        if (text.includes("commit-lock-probe") && !unlock) {
          unlock = setTimeout(() => { db.exec("COMMIT"); locked = false; }, 250);
        }
        if (text.includes('"id":1')) resolveReply();
      });
      child.once("error", reject);
      timeout = setTimeout(() => reject(new Error("fake ACP prompt timed out")), 4000);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "probe" }] } }) + "\n");
    await response;
    expect(db.prepare("SELECT COUNT(*) AS n FROM message_nodes").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT main_chain_id FROM sessions WHERE id='s'").get()).toEqual({ main_chain_id: 1 });
  } finally {
    clearTimeout(unlock);
    clearTimeout(timeout);
    if (locked) db.exec("ROLLBACK");
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill();
    await exited;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
