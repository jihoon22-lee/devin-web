import { describe, expect, it } from "vitest";
import { SessionManager } from "../lib/acp/manager";

/** Stub the bridge + ensure() so no real `devin acp` process is spawned. */
function stubbed(revertCapable = true, steps?: unknown[]) {
  const m = new SessionManager();
  const calls: { method: string; params: unknown }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (m as any).ensure = async () => {
    m.initResult = {
      protocolVersion: 1,
      agentCapabilities: {
        _meta: revertCapable ? { "cognition.ai/revert": true } : {},
      },
    } as never;
    return m.initResult;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (m.bridge as any).request = async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "_cognition.ai/revert/listSteps") {
      return {
        steps: steps ?? [
          { stepId: "a", stepNumber: 1, kind: "prompt", questionNodeId: 1, forkTargetNodeId: 10 },
          { stepId: "b", stepNumber: 2, kind: "prompt", questionNodeId: 11, forkTargetNodeId: 20 },
          { stepId: "c", stepNumber: 3, kind: "question", questionNodeId: 25 },
        ],
        nextCursor: null,
      };
    }
    if (method === "_cognition.ai/revert/forkFromStep") return { forkedSessionId: "fork-1" };
    if (method === "session/load") return { sessionId: "fork-1" };
    if (method === "session/list") return { sessions: [] };
    return {};
  };
  return { m, calls };
}

describe("SessionManager.forkAtNode", () => {
  it("forks at the step whose fork anchor covers the clicked node", async () => {
    const { m, calls } = stubbed();
    const res = await m.forkAtNode("s1", "/tmp/x", 5);
    expect(res.sessionId).toBe("fork-1");
    const fork = calls.find((c) => c.method === "_cognition.ai/revert/forkFromStep");
    // node 5 sits in step 1's span → clone ends at that step's anchor (10)
    expect(fork?.params).toEqual({ sessionId: "s1", targetNodeId: 10 });
  });

  it("sorts steps by anchor before picking the covering step", async () => {
    // the protocol does not promise order — the covering step is the SMALLEST
    // anchor ≥ node, not the first matching entry in the returned list
    const { m, calls } = stubbed(true, [
      { stepId: "b", stepNumber: 2, kind: "prompt", questionNodeId: 11, forkTargetNodeId: 20 },
      { stepId: "a", stepNumber: 1, kind: "prompt", questionNodeId: 1, forkTargetNodeId: 10 },
      { stepId: "c", stepNumber: 3, kind: "prompt", questionNodeId: 21, forkTargetNodeId: 30 },
    ]);
    await m.forkAtNode("s1", "/tmp/x", 5);
    const fork = calls.find((c) => c.method === "_cognition.ai/revert/forkFromStep");
    expect(fork?.params).toEqual({ sessionId: "s1", targetNodeId: 10 });
  });

  it("a node past every anchor falls back to the latest forkable step", async () => {
    const { m, calls } = stubbed();
    await m.forkAtNode("s1", "/tmp/x", 30);
    const fork = calls.find((c) => c.method === "_cognition.ai/revert/forkFromStep");
    expect(fork?.params).toEqual({ sessionId: "s1", targetNodeId: 20 });
  });

  it("refuses when the agent never echoed the revert capability", async () => {
    const { m, calls } = stubbed(false);
    await expect(m.forkAtNode("s1", "/tmp/x", 5)).rejects.toThrow(/revert/i);
    expect(calls.some((c) => c.method === "_cognition.ai/revert/forkFromStep")).toBe(false);
  });

  it("fails clearly when no step carries a fork anchor", async () => {
    const { m } = stubbed();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m.bridge as any).request = async (method: string) => {
      if (method === "_cognition.ai/revert/listSteps")
        return { steps: [{ stepId: "q", stepNumber: 1, kind: "question", questionNodeId: 40 }] };
      return {};
    };
    await expect(m.forkAtNode("s1", "/tmp/x", 5)).rejects.toThrow(/step/i);
  });

  it("loads the forked session so it is attached, not just created", async () => {
    const { m, calls } = stubbed();
    await m.forkAtNode("s1", "/tmp/x", 5);
    const load = calls.find((c) => c.method === "session/load");
    expect((load?.params as { sessionId?: string })?.sessionId).toBe("fork-1");
  });
});
