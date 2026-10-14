import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { pathInRoots, resolveAgentPath } from "../lib/acp/fsGate.mjs";

const ROOT = "/srv/allowed";
const CWD = "/home/u/proj";

describe("agent fs gate (lib/acp/fsGate.mjs)", () => {
  it("empty roots = unrestricted, but never widened by an empty list", () => {
    expect(pathInRoots("/anything", [])).toBe(true);
    expect(pathInRoots("/srv/allowedX/f", [ROOT])).toBe(false);
    expect(pathInRoots(join(ROOT, "f"), [ROOT])).toBe(true);
  });

  it("resolves relative paths against the session cwd", () => {
    expect(resolveAgentPath("a/b.txt", CWD, [ROOT])).toBe(join(CWD, "a/b.txt"));
  });

  it("refuses a relative path when the session cwd is unknown", () => {
    expect(() => resolveAgentPath("b9.png", undefined, [])).toThrow("relative path without a known session cwd");
    expect(() => resolveAgentPath("b9.png", null, [ROOT])).toThrow("relative path without a known session cwd");
  });

  it("allows absolute paths inside roots even without a session cwd", () => {
    expect(resolveAgentPath(join(ROOT, "x"), undefined, [ROOT])).toBe(join(ROOT, "x"));
  });

  it("refuses paths outside both the roots and the session's own cwd", () => {
    expect(() => resolveAgentPath("../other/x", CWD, [ROOT])).toThrow("path outside DEVIN_WEB_FS_ROOTS");
    expect(() => resolveAgentPath("/etc/hostname", CWD, [ROOT])).toThrow("path outside DEVIN_WEB_FS_ROOTS");
  });
});
