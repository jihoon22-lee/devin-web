// Playwright owns this process. All children receive an allowlisted environment;
// teardown also runs when the fixture, production build, or startup fails.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stopFixtureDaemon } from "./cleanup-daemon.mjs";
import { fixtureEnvironment, fixturePaths } from "./environment.mjs";

const repository = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = fixturePaths(repository, process.argv.includes("--daemon"));
const env = fixtureEnvironment(fixture);
const next = join(repository, "node_modules/next/dist/bin/next");
let child;
let stopping = false;
let daemonStarted = false;

function stopChild() {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { stopping = true; stopChild(); });
}
function run(command, args) {
  if (stopping) throw new Error("test server stopped");
  return new Promise((resolve, reject) => {
    child = spawn(command, args, { cwd: repository, env, stdio: "inherit", detached: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      child = undefined;
      if (code === 0 || stopping) resolve();
      else reject(new Error(`${command} exited ${code ?? signal}`));
    });
  });
}
function reapHolder() {
  try {
    const pid = Number(readFileSync(join(fixture.root, "lock-holder.pid"), "utf8"));
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    const variables = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    if (args.length === 2 && args[0] === "devin" && args[1] === "7200" &&
        variables.includes(`DEVIN_WEB_STATE_DIR=${fixture.state}`)) process.kill(pid, "SIGKILL");
  } catch { /* absent or identity changed */ }
}

try {
  // A stopped prior run must not leave its fake lock holder orphaned.
  reapHolder();
  // TMPDIR must exist even before make-fixture creates the rest.
  mkdirSync(join(fixture.root, "tmp"), { recursive: true });
  await run(process.execPath, [join(repository, "e2e/fixtures/make-fixture.mjs"), ...(fixture.daemon ? ["--daemon"] : [])]);
  await run(process.execPath, [next, "build"]);
  if (!stopping && fixture.daemon) {
    daemonStarted = true;
    await run(join(repository, "bin/devin-web-ctl"), ["start"]);
    // Keep the Playwright webServer owner alive until teardown sends SIGTERM.
    while (!stopping) await new Promise((resolve) => setTimeout(resolve, 200));
  } else if (!stopping) {
    await run(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", env.DEVIN_WEB_PORT]);
  }
} catch (error) {
  if (!stopping) { console.error(error); process.exitCode = 1; }
} finally {
  stopChild();
  try {
    if (daemonStarted) await stopFixtureDaemon(fixture, env);
  } finally {
    reapHolder();
  }
  rmSync(fixture.root, { recursive: true, force: true });
}
