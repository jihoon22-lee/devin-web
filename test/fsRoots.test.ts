import { afterEach, describe, expect, it } from "vitest";
import {
  fsPathAllowed,
  pathInRoots,
  setFsRootsForTest,
  setSessionRootsProvider,
} from "../lib/fsRoots";

describe("pathInRoots", () => {
  const roots = ["/home/u/proj", "/srv/data"];

  it("allows everything when no roots are configured", () => {
    expect(pathInRoots("/etc/passwd", [])).toBe(true);
  });

  it("allows the root itself and descendants", () => {
    expect(pathInRoots("/home/u/proj", roots)).toBe(true);
    expect(pathInRoots("/home/u/proj/src/a.ts", roots)).toBe(true);
    expect(pathInRoots("/srv/data/x", roots)).toBe(true);
  });

  it("rejects siblings that merely share a prefix", () => {
    expect(pathInRoots("/home/u/projects2", roots)).toBe(false);
    expect(pathInRoots("/home/u/proj-secret", roots)).toBe(false);
  });

  it("rejects paths outside the roots and traversal escapes", () => {
    expect(pathInRoots("/etc/passwd", roots)).toBe(false);
    expect(pathInRoots("/home/u/proj/../../etc/passwd", roots)).toBe(false);
  });
});

describe("fsPathAllowed — session working directories", () => {
  // a narrow static allowlist (only the web repo) — without it every
  // assertion below is vacuous (unset DEVIN_WEB_FS_ROOTS allows all)
  const STATIC = ["/home/u/projects/devin-web"];
  afterEach(() => {
    setFsRootsForTest(null);
    setSessionRootsProvider(null);
  });

  it("allows paths inside a session cwd even outside DEVIN_WEB_FS_ROOTS", () => {
    // the static allowlist only covers the repo; a playground session's own
    // project must still be browsable
    setFsRootsForTest(STATIC);
    setSessionRootsProvider(() => ["/home/u/playground/proj"]);
    expect(fsPathAllowed("/home/u/playground/proj/src/a.ts")).toBe(true);
    expect(fsPathAllowed("/home/u/playground/proj")).toBe(true);
    // the static root still works
    expect(fsPathAllowed("/home/u/projects/devin-web/package.json")).toBe(true);
  });

  it("does not widen to siblings or unrelated paths", () => {
    setFsRootsForTest(STATIC);
    setSessionRootsProvider(() => ["/home/u/playground/proj"]);
    expect(fsPathAllowed("/home/u/playground/other-secret")).toBe(false);
    expect(fsPathAllowed("/home/u/playground/proj2/file")).toBe(false);
    expect(fsPathAllowed("/etc/passwd")).toBe(false);
  });

  it("keeps the static gate when there are no session dirs at all", () => {
    // pathInRoots([]) means "no restriction" — an empty session list must
    // not silently open the whole tree while DEVIN_WEB_FS_ROOTS is set
    setFsRootsForTest(STATIC);
    setSessionRootsProvider(() => []);
    expect(fsPathAllowed("/home/u/projects/devin-web/package.json")).toBe(true);
    expect(fsPathAllowed("/home/u/playground/proj/x")).toBe(false);
    expect(fsPathAllowed("/etc/passwd")).toBe(false);
  });

  it("keeps the stale cache when the provider fails (db locked)", () => {
    setFsRootsForTest(STATIC);
    let dirs: string[] | null = ["/home/u/playground/proj"];
    setSessionRootsProvider(() => dirs);
    expect(fsPathAllowed("/home/u/playground/proj/x")).toBe(true);
    // provider now fails — cached roots must keep serving until TTL
    dirs = null;
    expect(fsPathAllowed("/home/u/playground/proj/x")).toBe(true);
    // but an outside path stays denied — failure must not widen the gate
    expect(fsPathAllowed("/etc/passwd")).toBe(false);
  });
});
