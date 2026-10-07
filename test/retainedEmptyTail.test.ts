import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionsDb } from "./fixtures/sessions-db";

const dir = mkdtempSync(join(tmpdir(), "dw-empty-tail-review-"));
process.env.DEVIN_CLI_DIR = dir;
process.env.DEVIN_WEB_STATE_DIR = dir;
const { readTranscriptItems } = await import("../lib/transcript-db");
const { resetTreeIndex } = await import("../lib/treeIndex");
afterAll(() => { resetTreeIndex(); rmSync(dir, { recursive: true, force: true }); });

it("a real canonical tail can be empty and truncated while an older retained anchor exists", () => {
  const db = createSessionsDb(dir);
  try {
    db.prepare("INSERT INTO sessions(id,main_chain_id) VALUES ('s',10000)").run();
    const put = db.prepare("INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES ('s',?,NULL,?,1)");
    put.run(20, JSON.stringify({ message_id: "visible-anchor", role: "assistant", content: "older anchor" }));
    for (let i = 1; i <= 10; i++) put.run(i * 1000, JSON.stringify({ message_id: `filtered-${i}`, role: "system", content: "filtered" }));
  } finally { db.close(); }
  expect(readTranscriptItems("s", { tail: 80, through: 10000 })).toEqual({ items: [], truncated: true });
  expect(readTranscriptItems("s", { head: 20 }).items).toMatchObject([{ id: 20, text: "older anchor" }]);
});
