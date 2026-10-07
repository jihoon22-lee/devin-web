import { describe, expect, it } from "vitest";
import { cleanupTargets, type CleanupCandidate } from "../lib/client/cleanupTargets";

const CUTOFF = "2026-09-22T00:00:00.000Z";
const OLD = "2026-09-01T00:00:00.000Z";
const NEW = "2026-09-28T00:00:00.000Z";

const s = (over: Partial<CleanupCandidate> & { sessionId: string }): CleanupCandidate => ({
  updatedAt: OLD,
  ...over,
});

describe("cleanupTargets", () => {
  it("keeps plain sessions older than the cutoff", () => {
    const out = cleanupTargets([s({ sessionId: "a" })], new Set(), null, CUTOFF);
    expect(out.map((x) => x.sessionId)).toEqual(["a"]);
  });

  it("excludes sessions that cannot be proven disposable", () => {
    const out = cleanupTargets(
      [
        s({ sessionId: "active", active: true }),
        s({ sessionId: "locked", isLocked: true }),
        s({ sessionId: "open" }),
        s({ sessionId: "archived", archived: true }),
        s({ sessionId: "pinned" }),
        s({ sessionId: "undated", updatedAt: null }),
        s({ sessionId: "missing-stamp", updatedAt: undefined }),
        s({ sessionId: "fresh", updatedAt: NEW }),
        s({ sessionId: "boundary", updatedAt: CUTOFF }), // not < cutoff
      ],
      new Set(["pinned"]),
      "open",
      CUTOFF,
    );
    expect(out).toEqual([]);
  });

  it("only the pin set standing between an old session and deletion", () => {
    const list = [s({ sessionId: "a" }), s({ sessionId: "b" })];
    expect(cleanupTargets(list, new Set(["a"]), null, CUTOFF).map((x) => x.sessionId)).toEqual(["b"]);
  });
});
