import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const stateDir = mkdtempSync(join(tmpdir(), "dw-runprompt-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

import { SessionManager } from "../lib/acp/manager";
import { METHODS } from "../lib/acp/types";
import { readAllQueues } from "../lib/promptQueue";

/* eslint-disable @typescript-eslint/no-explicit-any */

function stubbed(): SessionManager {
  const m = new SessionManager();
  (m as any).ensure = async () => ({});
  return m;
}

const loaded = (m: SessionManager, id: string) => {
  const mi = m as any;
  mi.sessions.set(id, {
    sessionId: id, cwd: "/tmp", running: false, loaded: true,
    attachedGen: mi.generation, queue: [],
  });
};

const notices = (m: SessionManager, id: string) =>
  (m as any).view.meta(id).items?.filter((i: any) => i.kind === "notice") ?? [];

describe("runPrompt start-block failure (crash safety)", () => {
  it("contains a start failure and autonomously retries all prompts in FIFO order", async () => {
    vi.useFakeTimers();
    const m = stubbed();
    loaded(m, "s1");
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);

    const sent: string[] = [];
    (m.bridge as any).request = async (method: string, p: any) => {
      if (method === METHODS.sessionPrompt) sent.push(p.prompt[0].text);
      return {};
    };

    // park A and B while the session reports running
    const s = (m as any).sessions.get("s1");
    s.running = true;
    await m.prompt("s1", [{ type: "text", text: "A" }]);
    await m.prompt("s1", [{ type: "text", text: "B" }]);
    s.running = false;

    // the next turn's start block throws — previously this left
    // running=true forever and wedged the queue
    const regions = (m as any).regions;
    const beginTurn = regions.beginTurn.bind(regions);
    let fail = true;
    regions.beginTurn = (sid: string) => {
      if (fail) { fail = false; throw new Error("boom"); }
      return beginTurn(sid);
    };
    // No new turn exists yet: do not emit turn_error into the previous
    // region. Report the start failure as a notice while preserving input.
    const errors: string[] = [];
    const origEmit = (m as any).emit.bind(m);
    (m as any).emit = (sid: string, type: string, data: any) => {
      if (type === "turn_error") errors.push(data.message);
      return origEmit(sid, type, data);
    };
    try {
      await expect(m.prompt("s1", [{ type: "text", text: "X" }])).resolves.toEqual({ queued: true });
      expect(sent).toEqual([]);
      expect(s.queue.map((q: any) => q.blocks[0].text)).toEqual(["A", "B", "X"]);
      expect(readAllQueues().s1.map((q) => q.blocks[0])).toEqual([
        { type: "text", text: "A" }, { type: "text", text: "B" }, { type: "text", text: "X" },
      ]);
      expect(notices(m, "s1").some((n: any) => n.text.includes("boom"))).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);

      expect(sent).toEqual(["A", "B", "X"]);
      expect(s.running).toBe(false);
      expect(s.queue).toHaveLength(0);
      expect(errors).toEqual([]);
      // the error notice was retired when the next turn started
      expect(notices(m, "s1")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent).toEqual(["A", "B", "X"]);
      expect(rejections).toEqual([]);
    } finally {
      regions.beginTurn = beginTurn;
      process.off("unhandledRejection", onRejection);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("an escaped rejection from finally is contained by launchPrompt without double-draining", async () => {
    const m = stubbed();
    loaded(m, "s2");
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);

    (m.bridge as any).request = async () => ({});

    const afterTurn = (m as any).afterTurn.bind(m);
    let thrown = false;
    (m as any).afterTurn = (s: any) => {
      if (!thrown) { thrown = true; throw new Error("afterTurn boom"); }
      afterTurn(s);
    };
    try {
      await m.prompt("s2", [{ type: "text", text: "X" }]);
      await new Promise((r) => setTimeout(r, 10));

      const s = (m as any).sessions.get("s2");
      expect(s.running).toBe(false);
      expect(s.ownsTurn).toBe(false);
      // runPrompt's own catch emitted the successful turn_end; the escaped
      // rejection came from finally and reached only launchPrompt's guard —
      // no second turn_error was appended
      expect(notices(m, "s2")).toHaveLength(0);
      await new Promise((r) => setTimeout(r, 10));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
