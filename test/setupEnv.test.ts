import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPool, terminalPool } from "../lib/acp/terminal";

describe("test env isolation (L12)", () => {
  it("socket env inherited from an agent shell never reaches a test", () => {
    expect(process.env.DEVIN_WEB_ACP_SOCK).toBeUndefined();
    expect(process.env.DEVIN_WEB_HOST_SOCK).toBeUndefined();
    expect(terminalPool).toBe(localPool); // not the remote host facade
  });

  it("state and CLI dirs resolve to isolated per-file tmpdirs by default", () => {
    const tmp = join(tmpdir(), "/");
    expect(process.env.DEVIN_WEB_STATE_DIR?.startsWith(tmp)).toBe(true);
    expect(process.env.DEVIN_CLI_DIR?.startsWith(tmp)).toBe(true);
  });
});
