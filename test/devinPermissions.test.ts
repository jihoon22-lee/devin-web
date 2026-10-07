import { describe, expect, it } from "vitest";
import { readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devinConfigPath, listAllowRules, revokeAllowRules } from "../lib/devinPermissions";

describe("devin allow-always rules", () => {
  it("never points at the real config under test", () => {
    expect(devinConfigPath().startsWith(join(tmpdir(), "/"))).toBe(true);
  });

  it("lists and revokes rules, preserving every other key and the file mode", () => {
    const p = devinConfigPath();
    writeFileSync(p, JSON.stringify({ version: 1, agent: { model: "m" }, permissions: { allow: ["Exec(ls)", "Exec(rm)", "Read(*)"], deny: ["x"] } }, null, 2));
    chmodSync(p, 0o600);
    expect(listAllowRules()).toEqual(["Exec(ls)", "Exec(rm)", "Read(*)"]);
    expect(revokeAllowRules(["Exec(rm)", "Exec(nope)"])).toEqual(["Exec(ls)", "Read(*)"]);
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    expect(cfg).toEqual({ version: 1, agent: { model: "m" }, permissions: { allow: ["Exec(ls)", "Read(*)"], deny: ["x"] } });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("reports an unreadable config as null", () => {
    writeFileSync(devinConfigPath(), "{not json");
    expect(listAllowRules()).toBeNull();
    expect(revokeAllowRules(["a"])).toBeNull();
  });
});
