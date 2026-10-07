import { describe, expect, it, vi } from "vitest";
import { PendingRequests } from "../lib/acp/pendingRequests";
import { METHODS } from "../lib/acp/types";

const fakeEv = (sessionId: string, method: string = METHODS.requestPermission) => {
  const answers: unknown[] = [];
  return {
    answers,
    ev: {
      rpcId: 1,
      method,
      params: { sessionId },
      respond: (r: unknown) => void answers.push(r),
      respondError: (code: number, message: string) => void answers.push({ code, message }),
    },
  };
};

describe("PendingRequests (F1)", () => {
  it("binds answers to the owning session and emits done + changed", () => {
    const emit = vi.fn();
    const changed = vi.fn();
    const p = new PendingRequests({ emit, changed });
    const { ev, answers } = fakeEv("s1");
    const pr = p.add(ev);

    expect(pr.requestId).toMatch(/^req-1-[0-9a-f]{12}$/);
    expect(p.respond(pr.requestId, { ok: 1 }, "s2")).toBe(false); // another session's route
    expect(p.respond(pr.requestId, { ok: 1 }, "s1")).toBe(true);
    expect(answers).toEqual([{ ok: 1 }]);
    expect(emit).toHaveBeenCalledWith("s1", "client_request_done", { requestId: pr.requestId });
    expect(changed).toHaveBeenCalledTimes(2); // added + settled
    expect(p.forSession("s1")).toEqual([]);
  });

  it("done events carry a resolvedWith label describing the pick", () => {
    const emit = vi.fn();
    const p = new PendingRequests({ emit, changed: vi.fn() });
    const { ev } = fakeEv("s1");
    (ev.params as Record<string, unknown>).options = [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ];
    const pr = p.add(ev);
    p.respond(pr.requestId, { outcome: { outcome: "selected", optionId: "once" } }, "s1");
    expect(emit).toHaveBeenLastCalledWith("s1", "client_request_done", {
      requestId: pr.requestId,
      resolvedWith: "Allow once",
    });

    // cancellation reports Cancelled; an unknown optionId keeps the raw id
    const b = fakeEv("s1");
    const pr2 = p.add(b.ev);
    p.cancel(pr2.requestId, "s1");
    expect(emit).toHaveBeenLastCalledWith("s1", "client_request_done", {
      requestId: pr2.requestId,
      resolvedWith: "Cancelled",
    });
    const c = fakeEv("s1", METHODS.elicitationCreate);
    const pr3 = p.add(c.ev);
    p.respond(pr3.requestId, { action: "accept", content: {} }, "s1");
    expect(emit).toHaveBeenLastCalledWith("s1", "client_request_done", {
      requestId: pr3.requestId,
      resolvedWith: "Accepted",
    });
  });

  it("cancel answers with the protocol-defined cancellation per method", () => {
    const p = new PendingRequests({ emit: vi.fn(), changed: vi.fn() });
    const a = fakeEv("s1", METHODS.requestPermission);
    const b = fakeEv("s1", METHODS.elicitationCreate);
    p.cancel(p.add(a.ev).requestId);
    p.cancel(p.add(b.ev).requestId);
    expect(a.answers).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(b.answers).toEqual([{ action: "cancel" }]);
  });

  it("rejectAll answers every pending request with the error", () => {
    const p = new PendingRequests({ emit: vi.fn(), changed: vi.fn() });
    const a = fakeEv("s1");
    const b = fakeEv("s2");
    p.add(a.ev);
    p.add(b.ev);
    p.rejectAll(-32603, "devin acp exited");
    expect([...a.answers, ...b.answers]).toEqual([
      { code: -32603, message: "devin acp exited" },
      { code: -32603, message: "devin acp exited" },
    ]);
    expect(p.map.size).toBe(0);
  });
});
