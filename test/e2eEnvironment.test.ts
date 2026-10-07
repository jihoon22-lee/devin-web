import { describe, expect, it } from "vitest";
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
    for (const key of ["DEVIN_WEB_ACP_SOCK", "DEVIN_WEB_HOST_SOCK", "BASH_ENV", "NODE_OPTIONS", "DEVIN_API_KEY", "CODEX_HOME", "PORT"]) {
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
});
