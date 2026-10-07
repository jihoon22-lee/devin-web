import { spawn } from "node:child_process";
import { join } from "node:path";

// Keep both PID and launch identities intact: ctl is the ownership authority.
// Reject before the caller removes the fixture, preserving recovery evidence
// when a process is unverified or the controller cannot complete shutdown.
export function stopFixtureDaemon(fixture, env) {
  return new Promise((resolve, reject) => {
    const cleanup = spawn(join(fixture.repository, "bin/devin-web-ctl"), ["stop", "--all"], {
      cwd: fixture.repository, env, stdio: "inherit",
    });
    cleanup.once("error", reject);
    cleanup.once("exit", (code, signal) => {
      if (code === 0) resolve(0);
      else reject(new Error(`Fixture cleanup failed (${code ?? signal}); preserved ${fixture.root}`));
    });
  });
}
