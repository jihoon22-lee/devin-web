import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = vi.hoisted(() => ({
  createdCwds: [] as string[],
  sessions: [] as { sessionId: string; cwd: string }[],
  failCreate: false,
}));
vi.mock("@/lib/state", () => ({
  manager: () => ({
    createSession: async (cwd: string) => {
      if (live.failCreate) throw new Error("session/new failed");
      live.createdCwds.push(cwd);
      return { sessionId: `wt-sess-${live.createdCwds.length}` };
    },
    listSessions: async () => live.sessions,
    pendingFor: () => [],
    deleteSession: async () => ({}),
    get bridgePid() { return null; },
  }),
}));
// sessions route also reads sessions.db for activity/hidden — keep it absent
const dir = mkdtempSync(join(tmpdir(), "dw-wt-route-"));
process.env.DEVIN_WEB_STATE_DIR = join(dir, "state");
const { POST, GET } = await import("../app/api/sessions/route");
const { DELETE } = await import("../app/api/sessions/[id]/route");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const req = (body: object) =>
  new Request("http://localhost/api/sessions", { method: "POST", body: JSON.stringify(body) });

function repo() {
  const d = mkdtempSync(join(tmpdir(), "dw-wt-repo-"));
  execFileSync("git", ["-C", d, "init", "-q"]);
  writeFileSync(join(d, "f.txt"), "x\n");
  execFileSync("git", ["-C", d, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  execFileSync("git", ["-C", d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return d;
}

describe("POST /api/sessions {worktree:true}", () => {
  beforeEach(() => {
    live.createdCwds = [];
    live.sessions = [];
    live.failCreate = false;
  });

  it("creates the session inside a fresh worktree, not the repo", async () => {
    const r = repo();
    const res = await POST(new (await import("next/server")).NextRequest(req({ cwd: r, worktree: true })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toMatch(/^wt-sess-/);
    expect(body.worktree).toMatchObject({ branch: expect.stringMatching(/^devin-web\//), repo: r });
    expect(live.createdCwds[0]).toBe(body.worktree.path);
    expect(existsSync(body.worktree.path)).toBe(true);
  });

  it("rolls back the worktree when session creation fails", async () => {
    const r = repo();
    live.failCreate = true;
    const res = await POST(new (await import("next/server")).NextRequest(req({ cwd: r, worktree: true })));
    expect(res.status).toBe(500);
    // no orphan worktree dir may be left behind
    const wtDir = join(process.env.DEVIN_WEB_STATE_DIR!, "worktrees");
    const orphans = existsSync(wtDir)
      ? execFileSync("git", ["-C", r, "worktree", "list", "--porcelain"]).toString()
      : "";
    expect(orphans).not.toContain("worktrees/");
  });

  it("rejects a non-git cwd with a clear error", async () => {
    const d = mkdtempSync(join(tmpdir(), "dw-wt-plain-"));
    const res = await POST(new (await import("next/server")).NextRequest(req({ cwd: d, worktree: true })));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/git/i);
  });

  it("plain create is unchanged", async () => {
    const res = await POST(new (await import("next/server")).NextRequest(req({ cwd: "/tmp" })));
    expect(res.status).toBe(200);
    expect(live.createdCwds).toEqual(["/tmp"]);
  });
});

describe("POST /api/sessions cwd validation", () => {
  beforeEach(() => {
    live.createdCwds = [];
    live.sessions = [];
    live.failCreate = false;
  });
  const post = async (body: object) =>
    POST(new (await import("next/server")).NextRequest(req(body)));

  it("rejects a non-directory cwd with 400", async () => {
    const res = await post({ cwd: join(dir, "no-such-dir") });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a directory/);
    expect(live.createdCwds).toEqual([]);
  });

  it("rejects a regular file cwd with 400", async () => {
    const f = join(dir, "file.txt");
    writeFileSync(f, "x");
    const res = await post({ cwd: f });
    expect(res.status).toBe(400);
  });

  it("with DEVIN_WEB_FS_ROOTS configured, a cwd outside the roots is 403 — a session cwd would auto-widen the allowlist", async () => {
    const { setFsRootsForTest } = await import("../lib/fsRoots");
    const allowed = mkdtempSync(join(tmpdir(), "dw-roots-"));
    setFsRootsForTest([allowed]);
    try {
      const denied = await post({ cwd: "/" });
      expect(denied.status).toBe(403);
      const ok = await post({ cwd: join(allowed, "sub") });
      expect(ok.status).toBe(400); // inside a root but doesn't exist → 400 first
      writeFileSync(join(allowed, "f.txt"), "x");
      const okDir = mkdtempSync(join(allowed, "sub-"));
      const created = await post({ cwd: okDir });
      expect(created.status).toBe(200);
      expect(live.createdCwds.at(-1)).toBe(okDir);
    } finally {
      setFsRootsForTest(null);
    }
  });

  it("with no roots configured (default), any existing directory is allowed", async () => {
    const { setFsRootsForTest } = await import("../lib/fsRoots");
    setFsRootsForTest([]);
    try {
      const res = await post({ cwd: "/tmp" });
      expect(res.status).toBe(200);
      expect(live.createdCwds.at(-1)).toBe("/tmp");
    } finally {
      setFsRootsForTest(null);
    }
  });
});

describe("GET /api/sessions worktree field + DELETE leftover", () => {
  it("marks worktree sessions and reports the leftover on delete", async () => {
    const r = repo();
    const res = await POST(new (await import("next/server")).NextRequest(req({ cwd: r, worktree: true })));
    const { sessionId, worktree } = await res.json();
    live.sessions = [{ sessionId, cwd: worktree.path }];

    const list = await (await GET(new (await import("next/server")).NextRequest(
      "http://localhost/api/sessions",
    ))).json();
    expect(list.sessions[0].worktree).toMatchObject({ branch: worktree.branch, repo: r });

    const del = await DELETE(new Request(`http://localhost/api/sessions/${sessionId}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: sessionId }) });
    const body = await del.json();
    expect(body.leftoverWorktree).toMatchObject({ path: worktree.path, branch: worktree.branch });
    // the worktree itself is NOT removed — session delete ≠ worktree delete
    expect(existsSync(worktree.path)).toBe(true);
  });
});
