import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionsDb } from "./fixtures/sessions-db";
import { applyViewFrame, emptySessionState } from "../lib/client/model";
import type { ViewFrame } from "../lib/acp/sessionView";
const dir = mkdtempSync(join(tmpdir(), "view-crash-"));
process.env.DEVIN_WEB_STATE_DIR = dir;
process.env.DEVIN_CLI_DIR = dir;
const db = createSessionsDb(dir);
db.prepare("INSERT INTO sessions(id, main_chain_id) VALUES (?, ?)").run("reader-failure", 1);
db.prepare("INSERT INTO message_nodes(session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)")
  .run("reader-failure", 1, JSON.stringify({ message_id: "saved", role: "assistant", content: "saved history" }), 1);
db.prepare("INSERT INTO sessions(id) VALUES (?)").run("empty-session");
db.close();
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const { manager } = await import("../lib/state");
const { attachStream, detachStream, unsubscribe } = await import("../lib/stream/connections");

const { POST } = await import("../app/api/stream/subscribe/route");
const { NextRequest } = await import("next/server");

it("preserves displayed history when the actual SQLite reader fails, then restores it on a quiet route retry", async () => {
  const sid = "reader-failure";
  const spec = [{ kind: "view" as const, id: sid }];
  const displayed = emptySessionState();
  const initial = manager().viewSnapshot(sid);
  expect(initial.durable).toMatchObject([{ messageId: "saved", text: "saved history" }]);
  applyViewFrame(displayed, initial);
  const history = displayed.durable;
  const frames: ViewFrame[] = [];
  attachStream(sid, 0, (msg) => {
    if (msg.kind === "view") {
      const frame = msg.view as ViewFrame;
      frames.push(frame);
      applyViewFrame(displayed, frame);
    }
    return true;
  });
  const post = () => POST(new NextRequest("http://localhost/api/stream/subscribe", {
    method: "POST", body: JSON.stringify({ connId: sid, remove: spec, add: spec }),
  }));
  try {
    // Fail the real readTranscriptItems/openSessionsDb boundary, not the
    // manager method. Only this test's closed fixture database is moved.
    renameSync(join(dir, "sessions.db"), join(dir, "sessions.offline"));
    try {
      const response = await post();
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
      expect(frames.filter((frame) => frame.t === "snapshot")).toEqual([]);
      expect(displayed.durable).toBe(history);
    } finally {
      renameSync(join(dir, "sessions.offline"), join(dir, "sessions.db"));
    }
    // The client's forced retry removes and re-adds the view subscription.
    // No later agent event or database commit is needed to repair the view.
    const response = await post();
    expect(response.status).toBe(200);
    const snapshots = frames.filter((frame) => frame.t === "snapshot");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].durable).toEqual(initial.durable);
    expect(displayed.durable).toEqual(history);
  } finally {
    unsubscribe(sid, spec);
    detachStream(sid);
  }
});

it("returns a successful authoritative empty snapshot for a genuinely empty session", async () => {
  const sid = "empty-session";
  const spec = [{ kind: "view" as const, id: sid }];
  const frames: ViewFrame[] = [];
  attachStream(sid, 0, (msg) => {
    if (msg.kind === "view") frames.push(msg.view as ViewFrame);
    return true;
  });
  try {
    const response = await POST(new NextRequest("http://localhost/api/stream/subscribe", {
      method: "POST", body: JSON.stringify({ connId: sid, add: spec }),
    }));
    expect(response.status).toBe(200);
    expect(frames.filter((frame) => frame.t === "snapshot")).toEqual([
      expect.objectContaining({ durable: [], durableTruncated: false }),
    ]);
  } finally {
    unsubscribe(sid, spec);
    detachStream(sid);
  }
});

it("returns a retryable 500 on snapshot failure without rejection and reconnects at the unchanged cursor", async () => {
  const m = manager();
  const spec = [{ kind: "view" as const, id: "snapshot-failure" }];
  const rejections: unknown[] = [];
  const onRejection = (error: unknown) => rejections.push(error);
  process.on("unhandledRejection", onRejection);
  const snapshot = vi.spyOn(m, "viewSnapshot").mockImplementationOnce(() => { throw new Error("db unavailable"); });
  const frames: unknown[] = [];
  try {
    attachStream("snapshot-failure", 0, (msg) => { frames.push(msg.view); return true; });
    const response = await POST(new NextRequest("http://localhost/api/stream/subscribe", { method: "POST", body: JSON.stringify({ connId: "snapshot-failure", add: spec }) }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "db unavailable" });
    expect(frames.filter((frame) => (frame as { t?: string })?.t === "snapshot")).toEqual([]);
    detachStream("snapshot-failure");
    attachStream("snapshot-failure", 0, (msg) => { frames.push(msg.view); return true; });
    expect(frames.some((frame) => (frame as { t?: string })?.t === "snapshot")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejections).toEqual([]);
  } finally {
    snapshot.mockRestore();
    unsubscribe("snapshot-failure", spec);
    detachStream("snapshot-failure");
    process.off("unhandledRejection", onRejection);
  }
});
