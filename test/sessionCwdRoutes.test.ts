import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = vi.hoisted(() => ({
  recorded: new Map<string, string>(),
  loads: [] as [string, string][],
  forks: [] as [string, string][],
}));
vi.mock("@/lib/state", () => ({
  manager: () => ({
    getSession: () => undefined,
    listSessions: async () => [...live.recorded].map(([sessionId, cwd]) => ({ sessionId, cwd })),
    loadSession: async (id: string, cwd: string) => { live.loads.push([id, cwd]); return { sessionId: id }; },
    fork: async (id: string, cwd: string) => { live.forks.push([id, cwd]); return { sessionId: `${id}-fork` }; },
    forkAtNode: async (id: string, cwd: string) => { live.forks.push([id, cwd]); return { sessionId: `${id}-fork` }; },
    defaultCwd: "/nonexistent-default",
    bridgePid: null,
    bridge: { socketMode: false },
  }),
}));

const dir = mkdtempSync(join(tmpdir(), "dw-cwd-routes-"));
process.env.DEVIN_WEB_STATE_DIR = join(dir, "state");
const allowed = join(dir, "allowed");
const outside = join(dir, "outside");
const { setFsRootsForTest } = await import("../lib/fsRoots");
const load = await import("../app/api/sessions/[id]/load/route");
const takeover = await import("../app/api/sessions/[id]/takeover/route");
const fork = await import("../app/api/sessions/[id]/fork/route");
afterAll(() => { setFsRootsForTest(null); rmSync(dir, { recursive: true, force: true }); });

const post = (body: object) => new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  live.recorded.clear(); live.loads.length = 0; live.forks.length = 0;
  setFsRootsForTest([allowed]);
});

describe("caller-supplied cwd on existing sessions (L1)", () => {
  it("load: refuses an arbitrary cwd outside the roots", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await load.POST(post({ cwd: outside }) as any, ctx("s1"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: `cwd outside DEVIN_WEB_FS_ROOTS: ${outside}` });
    expect(live.loads).toEqual([]);
  });

  it("load: accepts the session's own recorded cwd even outside the roots (recorded cwd)", async () => {
    live.recorded.set("cli-made", outside);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await load.POST(post({ cwd: outside }) as any, ctx("cli-made"));
    expect(res.status).toBe(200);
    expect(live.loads).toEqual([["cli-made", outside]]);
  });

  it("takeover: refuses an arbitrary cwd before touching any lock", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await takeover.POST(post({ cwd: outside }) as any, ctx("s2"));
    expect(res.status).toBe(403);
    expect(live.loads).toEqual([]);
  });

  it("fork: refuses a cwd that is neither inside the roots nor the parent's cwd", async () => {
    live.recorded.set("parent", join(allowed, "proj"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await fork.POST(post({ cwd: outside }) as any, ctx("parent"));
    expect(res.status).toBe(403);
    expect(live.forks).toEqual([]);
  });

  it("fork: a cwd inside the roots passes", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await fork.POST(post({ cwd: join(allowed, "proj") }) as any, ctx("parent"));
    expect(res.status).toBe(200);
  });

  it("unset roots keep today's unrestricted behavior", async () => {
    setFsRootsForTest([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await load.POST(post({ cwd: outside }) as any, ctx("s3"));
    expect(res.status).toBe(200);
  });
});
