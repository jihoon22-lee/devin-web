import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixtureEnvironment, fixturePaths } from "../e2e/fixtures/environment.mjs";
import { stopFixtureDaemon } from "../e2e/fixtures/cleanup-daemon.mjs";

it.each([
  { name: "pid", matchingEnvironment: true },
  { name: "pid", matchingEnvironment: false },
  { name: "pid.launch", matchingEnvironment: false },
])("preserves $name when a live PID cannot be verified (matching environment: $matchingEnvironment)", async ({ name, matchingEnvironment }) => {
  const scratch = mkdtempSync(join(tmpdir(), "dw-e2e-cleanup-"));
  const fixture = { ...fixturePaths(scratch, true), repository: process.cwd() };
  mkdirSync(fixture.state, { recursive: true });
  const env = { ...fixtureEnvironment(fixture), DEVIN_WEB_PORT: "0" };
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: matchingEnvironment ? env : { NODE_ENV: "test" }, stdio: "ignore" });
  await once(child, "spawn");
  const pidFile = join(fixture.state, name);
  writeFileSync(pidFile, String(child.pid));
  const evidence = join(fixture.state, "server.log");
  writeFileSync(evidence, "startup evidence");
  try {
    await expect(stopFixtureDaemon(fixture, env)).rejects.toThrow(/cleanup|stop/i);
    expect(readFileSync(pidFile, "utf8")).toBe(String(child.pid));
    expect(readFileSync(evidence, "utf8")).toBe("startup evidence");
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("reports a missing cleanup executable instead of accepting cleanup", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "dw-e2e-cleanup-missing-"));
  const fixture = fixturePaths(scratch, true);
  try {
    await expect(stopFixtureDaemon(fixture, fixtureEnvironment(fixture))).rejects.toThrow();
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

it("accepts successful cleanup of an empty isolated state", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "dw-e2e-cleanup-empty-"));
  const fixture = { ...fixturePaths(scratch, true), repository: process.cwd() };
  mkdirSync(fixture.state, { recursive: true });
  try {
    await expect(stopFixtureDaemon(fixture, { ...fixtureEnvironment(fixture), DEVIN_WEB_PORT: "0" })).resolves.toBe(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
