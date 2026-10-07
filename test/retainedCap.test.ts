import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const stateDir = mkdtempSync(join(tmpdir(), "dw-ret-state-"));
const cliDir = mkdtempSync(join(tmpdir(), "dw-ret-cli-")); // no sessions.db → empty spine
process.env.DEVIN_WEB_STATE_DIR = stateDir;
process.env.DEVIN_CLI_DIR = cliDir;
afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(cliDir, { recursive: true, force: true });
});

const { SessionManager } = await import("../lib/acp/manager");
const { METHODS } = await import("../lib/acp/types");
const { capRetainedTurns, turnKeyOf } = await import("../lib/acp/retained");
import type { AssembledItem } from "../lib/acp/itemAssembler";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const item = (id: string): AssembledItem => ({ id, kind: "text", role: "thought", text: id, done: true, seqFrom: 1, seqTo: 1 });

/** Each test owns its session id — the itemlog db is shared per process. */
function harness(sid: string) {
  const m = new SessionManager();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mi = m as any;
  mi.ensure = async () => ({});
  let finish: () => void = () => {};
  mi.bridge.request = async (method: string) => {
    if (method === METHODS.sessionPrompt) return new Promise<void>((r) => (finish = () => r()));
    return {};
  };
  mi.sessions.set(sid, { sessionId: sid, cwd: "/tmp", running: false, loaded: true, attachedGen: mi.generation, queue: [] });
  const frames: Record<string, unknown>[] = [];
  m.subscribeView(sid, (e) => {
    if (e.t === "patch" && (e.prov || e.retained)) frames.push(e as unknown as Record<string, unknown>);
  });
  /** one full turn: prompt → thought → flush → end → durable covers it */
  const turn = async (t: number) => {
    m.__testDurableThrough(sid, 100 + t * 10);
    await m.prompt(sid, [{ type: "text", text: `go ${t}` }]);
    mi.emit(sid, "session_update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `thought ${t}` } });
    await sleep(60); // 40ms provisional flush → itemlog save
    finish();
    await sleep(0);
    m.__testDurableThrough(sid, 105 + t * 10); // flip
  };
  return { m, frames, turn };
}

describe("capRetainedTurns (R12 B1)", () => {
  it("keys items by turn and keeps the newest N turns in order", () => {
    expect(turnKeyOf("p-tab12-7-3")).toBe("tab12-7");
    const items = Array.from({ length: 25 }, (_, t) => [item(`p-t${t}-0`), item(`p-t${t}-1`)]).flat();
    const out = capRetainedTurns(items, 20);
    expect(out).toHaveLength(40);
    expect(out[0].id).toBe("p-t5-0");
    expect(out.at(-1)!.id).toBe("p-t24-1");
  });
});

describe("retained budget in the manager (R12 B1)", () => {
  it("per-flush view patches carry no retained list; only the flip frame does", async () => {
    const h = harness("s-b1a");
    await h.turn(0);
    await sleep(60); // let a trailing flush land too
    const withRetained = h.frames.filter((f) => "retained" in f);
    expect(h.frames.length).toBeGreaterThan(withRetained.length); // flushes did happen
    expect(withRetained).toHaveLength(1); // the flip
    expect((withRetained[0].retained as unknown[]).length).toBe(1);
  });

  it("memory holds the same 20 turns a restarted process reloads", async () => {
    const h = harness("s-b1b");
    for (let t = 0; t < 25; t++) await h.turn(t);
    const ids = h.m.retained("s-b1b").map((i) => i.id);
    expect(new Set(ids.map(turnKeyOf)).size).toBe(20);
    expect(h.m.retained("s-b1b").map((i) => i.text)).toEqual(
      Array.from({ length: 20 }, (_, k) => `thought ${k + 5}`),
    );
    const fresh = new SessionManager(); // post-restart: loads from itemlog.db
    expect(fresh.retained("s-b1b").map((i) => i.id)).toEqual(ids);
  }, 20_000);
});
