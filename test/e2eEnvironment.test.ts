import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureEnvironment, fixturePaths } from "../e2e/fixtures/environment.mjs";

describe("E2E environment isolation", () => {
  it("replaces user state and excludes inherited daemon, shell and credential settings", () => {
    const fixture = fixturePaths("/tmp/example-repo");
    const env = fixtureEnvironment(fixture, {
      PATH: "/opt/node/bin:/usr/bin", HOME: "/real/home", XDG_CONFIG_HOME: "/real/config",
      DEVIN_WEB_STATE_DIR: "/real/state", DEVIN_WEB_ACP_SOCK: "/real/acp.sock",
      DEVIN_WEB_HOST_SOCK: "/real/host.sock", DEVIN_WEB_ACPD_PIDFILE: "/real/acpd.pid",
      DEVIN_WEB_DEVIN_CONFIG: "/real/config.json", DEVIN_WEB_FS_ROOTS: "/",
      FAKE_ACP_SCRIPT: "/real/script", BASH_ENV: "/real/startup", NODE_OPTIONS: "--require /real/code",
      DEVIN_API_KEY: "secret", CODEX_HOME: "/real/codex", PORT: "7100",
    });
    expect(env.HOME).toBe(fixture.home);
    expect(env.XDG_CONFIG_HOME).toBe(fixture.config);
    expect(env.XDG_DATA_HOME).toBe(fixture.data);
    expect(env.XDG_STATE_HOME).toBe(fixture.xdgState);
    expect(env.DEVIN_WEB_STATE_DIR).toBe(fixture.state);
    expect(env.DEVIN_WEB_DEVIN_CONFIG).toBe(fixture.devinConfig);
    expect(env.DEVIN_WEB_ACPD_PIDFILE).toBe(`${fixture.state}/acpd.pid`);
    expect(env.DEVIN_WEB_FS_ROOTS).toBe(fixture.root);
    expect(env.PATH).toBe("/opt/node/bin:/usr/bin");
    expect(env.DEVIN_WEB_ACP_SOCK).toBe("");
    expect(env.DEVIN_WEB_HOST_SOCK).toBe("");
    for (const key of ["BASH_ENV", "NODE_OPTIONS", "DEVIN_API_KEY", "CODEX_HOME", "PORT"]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env.DEVIN_WEB_ACPD).toBe("0");
    expect(env.DEVIN_WEB_DIST_DIR).toBe(".next-e2e");
    expect(env.DEVIN_WEB_PORT).toBe("3200");
  });

  it("gives the daemon its own fixture, sockets, dist and port", () => {
    const fixture = fixturePaths("/tmp/example-repo", true);
    const env = fixtureEnvironment(fixture, { PATH: "/usr/bin" });
    expect(fixture.root).toBe("/tmp/example-repo/.daemon-e2e-fixture");
    expect(env.DEVIN_WEB_ACPD).toBe("1");
    expect(env.DEVIN_WEB_ACP_SOCK).toBe(`${fixture.state}/acp.sock`);
    expect(env.DEVIN_WEB_HOST_SOCK).toBe(`${fixture.state}/host.sock`);
    expect(env.DEVIN_WEB_DIST_DIR).toBe(".next-daemon-e2e");
    expect(env.DEVIN_WEB_PORT).toBe("3201");
  });

  it.each([false, true])("blocks hostile Next dotenv settings in a fresh child (daemon: %s)", (daemon) => {
    const root = mkdtempSync(join(tmpdir(), "dw-dotenv-fixture-"));
    try {
      const fixture = fixturePaths(root, daemon);
      const env = fixtureEnvironment(fixture, { PATH: process.env.PATH });
      writeFileSync(join(root, ".env.production.local"), [
        "DEVIN_WEB_ACP_SOCK=/outside/real/acp.sock",
        "DEVIN_WEB_HOST_SOCK=/outside/real/host.sock",
        "DEVIN_WEB_STATE_DIR=/outside/real/state",
        "DEVIN_WEB_DEBUG=1",
        "DEVIN_WEB_TAILNET=outside.ts.net",
        "DEVIN_WEB_ALLOWED_HOSTS=outside.example",
        "DEVIN_WEB_PUSH_SUBJECT=mailto:outside@example.com",
        "DEVIN_WEB_ACP_FALLBACK=1",
        "E2E_DOTENV_LOADED=yes",
      ].join("\n"));
      // Resolve Next's actual dependency, including pnpm's non-hoisted layout.
      const require = createRequire(import.meta.url);
      const nextEnv = createRequire(require.resolve("next/package.json")).resolve("@next/env");
      const output = execFileSync(process.execPath, ["-e", `
        require(process.argv[1]).loadEnvConfig(process.argv[2]);
        const keys = ["DEVIN_WEB_ACP_SOCK", "DEVIN_WEB_HOST_SOCK", "DEVIN_WEB_STATE_DIR",
          "DEVIN_WEB_DEBUG", "DEVIN_WEB_TAILNET", "DEVIN_WEB_ALLOWED_HOSTS",
          "DEVIN_WEB_PUSH_SUBJECT", "DEVIN_WEB_ACP_FALLBACK", "E2E_DOTENV_LOADED"];
        process.stdout.write(JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key]]))));
      `, nextEnv, root], { env, encoding: "utf8" });
      expect(JSON.parse(output)).toEqual({
        DEVIN_WEB_ACP_SOCK: daemon ? join(fixture.state, "acp.sock") : "",
        DEVIN_WEB_HOST_SOCK: daemon ? join(fixture.state, "host.sock") : "",
        DEVIN_WEB_STATE_DIR: fixture.state,
        DEVIN_WEB_DEBUG: "",
        DEVIN_WEB_TAILNET: "",
        DEVIN_WEB_ALLOWED_HOSTS: "",
        DEVIN_WEB_PUSH_SUBJECT: "mailto:e2e@example.invalid",
        DEVIN_WEB_ACP_FALLBACK: "0",
        E2E_DOTENV_LOADED: "yes",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
