import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CTL = join(process.cwd(), "bin/devin-web-ctl");
const src = readFileSync(CTL, "utf8");
const tmp = mkdtempSync(join(tmpdir(), "dw-ctl-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("devin-web-ctl state dir (L2·L3)", () => {
  it("parses", () => {
    execFileSync("bash", ["-n", CTL]);
  });

  it("ensure_state leaves the state dir owner-only even if it already exists 0775", () => {
    const state = join(tmp, "state");
    const fn = /^ensure_state\(\) \{[\s\S]*?^\}/m.exec(src)?.[0];
    expect(fn).toBeTruthy();
    execFileSync("bash", ["-c", `mkdir -m 775 -p "$STATE"; ${fn}; ensure_state`], {
      env: { ...process.env, STATE: state },
    });
    expect((statSync(state).mode & 0o777).toString(8)).toBe("700");
  });

  it("no raw mkdir of $STATE remains outside ensure_state", () => {
    expect(src.split("\n").filter((l) => l.includes('mkdir -p "$STATE"'))).toHaveLength(1);
  });

  it("acpd is launched with the same DEVIN_WEB_STATE_DIR ctl uses", () => {
    expect(src).toMatch(/env "DEVIN_WEB_STATE_DIR=\$STATE"[^\n]*bin\/devin-acpd\.mjs/);
  });
});

  it("resolves STATE with the same precedence as lib/paths.mjs (R12 C4)", () => {
    const line = /^STATE=.*$/m.exec(src)![0];
    const run = (env: Record<string, string>) =>
      execFileSync("bash", ["-c", `${line}; printf %s "$STATE"`], {
        env: { NODE_ENV: "test", PATH: process.env.PATH!, HOME: "/h", ...env },
      }).toString();
    expect(run({ DEVIN_WEB_STATE_DIR: "/custom", XDG_STATE_HOME: "/x" })).toBe("/custom");
    expect(run({ XDG_STATE_HOME: "/x" })).toBe("/x/devin-web");
    expect(run({})).toBe("/h/.local/state/devin-web");
  });
