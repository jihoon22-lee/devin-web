import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  loadSession: vi.fn(),
  daemonState: vi.fn(),
  lockOwner: vi.fn(),
  killLockOwner: vi.fn(),
  removeLock: vi.fn(),
  mgr: {
    bridgePid: null as number | null,
    socketMode: false,
  },
}));

vi.mock("@/lib/state", () => ({
  manager: () => ({
    loadSession: h.loadSession,
    get bridgePid() { return h.mgr.bridgePid; },
    bridge: {
      get socketMode() { return h.mgr.socketMode; },
      daemonState: h.daemonState,
    },
  }),
}));
vi.mock("@/lib/locks", () => ({
  lockOwner: (sessionId: string, ourPid: number | null) => {
    const owner = h.lockOwner(sessionId, ourPid);
    return owner ? { ...owner, ours: owner.pid === ourPid } : owner;
  },
  killLockOwner: h.killLockOwner,
  removeLock: h.removeLock,
}));

import { POST } from "../app/api/sessions/[id]/takeover/route";

const post = (body = JSON.stringify({ cwd: "/tmp/x" })) =>
  POST(new NextRequest("http://localhost/api/sessions/s1/takeover", { method: "POST", body }), {
    params: Promise.resolve({ id: "s1" }),
  });

/** First load fails with a lock conflict; a live devin process holds it. */
function lockedSetup(ownerPid = 4242) {
  h.loadSession
    .mockRejectedValueOnce(new Error("session_locked: already open in another process"))
    .mockResolvedValue({ sessionId: "s1" });
  h.lockOwner.mockReturnValue({
    pid: ownerPid,
    cmdline: "/opt/devin/_versions/3000/bin/devin acp",
    alive: true,
    ours: false,
    isDevin: true,
  });
  h.killLockOwner.mockResolvedValue([ownerPid]);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.mgr.bridgePid = null;
  h.mgr.socketMode = false;
  h.loadSession.mockReset();
  h.killLockOwner.mockResolvedValue([4242]);
  h.removeLock.mockReturnValue(true);
});

describe("POST /api/sessions/:id/takeover pid attribution", () => {
  it("refuses to signal a live devin holder when our agent pid is unknown (daemon mode)", async () => {
    lockedSetup();
    h.mgr.socketMode = true;
    h.daemonState.mockResolvedValue({ gen: 1, acpPid: null, sessions: [] });
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("pid") });
    expect(h.killLockOwner).not.toHaveBeenCalled();
    expect(h.removeLock).not.toHaveBeenCalled();
  });

  it("treats the daemon's acpPid as ours — our own agent is never killed", async () => {
    lockedSetup(4242);
    h.mgr.socketMode = true;
    h.daemonState.mockResolvedValue({ gen: 1, acpPid: 4242, sessions: [] });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, took: false, killed: [] });
    expect(h.killLockOwner).not.toHaveBeenCalled();
  });

  it("kills a live devin holder once attribution is certain", async () => {
    lockedSetup(9999);
    h.mgr.socketMode = true;
    h.daemonState.mockResolvedValue({ gen: 1, acpPid: 4242, sessions: [] });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, took: true, killed: [9999] });
    expect(h.killLockOwner).toHaveBeenCalledOnce();
  });

  it("spawn mode without a bridge pid still refuses to signal a live devin holder", async () => {
    lockedSetup();
    const res = await post();
    expect(res.status).toBe(409);
    expect(h.killLockOwner).not.toHaveBeenCalled();
  });
});
