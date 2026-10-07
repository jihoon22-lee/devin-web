import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createSessionsDb } from "./fixtures/sessions-db";

const stateDir = mkdtempSync(join(tmpdir(), "dw-mgr-fin-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;
process.env.DEVIN_CLI_DIR = stateDir;
createSessionsDb(stateDir).close();
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

// Simulate a failed alignment read without replacing persistence or restore.
vi.mock("../lib/acp/alignSpine", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/acp/alignSpine")>();
  return { ...mod, computeAnchors: vi.fn(mod.computeAnchors) };
});

const { SessionManager } = await import("../lib/acp/manager");
const { METHODS } = await import("../lib/acp/types");
const { computeAnchors } = await import("../lib/acp/alignSpine");
const { itemLogRestore, itemLogResetForTests } = await import("../lib/itemLog");
const { integrityCount } = await import("../lib/integrityBeacon");

function stubbed(): InstanceType<typeof SessionManager> {
  const m = new SessionManager();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (m as any).ensure = async () => ({});
  return m;
}

describe("finalizeTurn failure recovery", () => {
  it("preserves the ended turn and recovers its latest thought after restart when alignment fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const beacons = integrityCount().total;
    vi.mocked(computeAnchors).mockImplementationOnce(() => { throw new Error("alignment boom"); });
    const m = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mi = m as any;
    mi.bridge.request = async (method: string) => {
      if (method === METHODS.sessionPrompt) return new Promise(() => {});
      return {};
    };
    mi.sessions.set("s1", {
      sessionId: "s1", cwd: "/tmp/x", running: false, loaded: true,
      attachedGen: mi.generation, queue: [],
    });
    const frames: { prov?: unknown; retained?: unknown }[] = [];
    m.subscribeView("s1", (e) => {
      if (e.t === "patch") frames.push(e);
    });
    m.__testDurableThrough("s1", 100);
    await m.prompt("s1", [{ type: "text", text: "go" }]);
    mi.emit("s1", "session_update", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "t" },
    });
    m.viewSnapshot("s1"); // publish a nonempty region baseline before the flip
    mi.emit("s1", "turn_end", {});
    m.__testDurableThrough("s1", 160); // flip — computeAnchors throws inside
    expect(m.provisional("s1")).toMatchObject([{ text: "go", done: true }, { text: "t", done: true }]);
    expect(m.durableThrough("s1")).toBe(100);
    expect(m.retained("s1")).toEqual([]);
    expect(itemLogRestore("s1")).toMatchObject({ ended: true, items: [{ text: "go" }, { text: "t" }] });
    expect(integrityCount().total).toBe(beacons + 1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("turnFinalizeFailed stage=alignment"));
    itemLogResetForTests();
    const restarted = stubbed();
    restarted.__testDurableThrough("s1", 160);
    expect(restarted.provisional("s1")).toEqual([]);
    expect(restarted.retained("s1")).toMatchObject([{ text: "t", done: true, anchorNode: 100 }]);
    expect(restarted.durableThrough("s1")).toBe(160);
    expect(itemLogRestore("s1")).toBeNull();
    mi.dbSub?.();
    itemLogResetForTests();
    error.mockRestore();
  });
});
