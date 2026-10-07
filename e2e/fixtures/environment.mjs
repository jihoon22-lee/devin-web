import { join } from "node:path";

export function fixturePaths(repository, daemon = false) {
  const root = join(repository, daemon ? ".daemon-e2e-fixture" : ".e2e-fixture");
  return {
    repository, daemon, root, home: join(root, "home"), config: join(root, "config"),
    data: join(root, "data"), xdgState: join(root, "xdg-state"), cache: join(root, "cache"),
    state: join(root, "state"), project: join(root, "project"), cli: join(root, "cli"),
    devinConfig: join(root, "config", "devin", "config.json"),
  };
}

/** @param {ReturnType<typeof fixturePaths>} fixture
 * @param {Record<string, string | undefined>} inherited */
export function fixtureEnvironment(fixture, inherited = process.env) {
  // Preserve executable discovery, never application or shell configuration.
  return {
    PATH: inherited.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: fixture.home,
    XDG_CONFIG_HOME: fixture.config,
    XDG_DATA_HOME: fixture.data,
    XDG_STATE_HOME: fixture.xdgState,
    XDG_CACHE_HOME: fixture.cache,
    TMPDIR: join(fixture.root, "tmp"),
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
    TZ: "UTC",
    CI: "1",
    NODE_ENV: /** @type {"production"} */ ("production"),
    NEXT_TELEMETRY_DISABLED: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    DEVIN_CLI_DIR: fixture.cli,
    DEVIN_WEB_STATE_DIR: fixture.state,
    DEVIN_WEB_DEVIN_CONFIG: fixture.devinConfig,
    DEVIN_WEB_DEVIN_BIN: join(fixture.root, "fake-devin"),
    DEVIN_WEB_ACPD_PIDFILE: join(fixture.state, "acpd.pid"),
    DEVIN_WEB_FS_ROOTS: fixture.root,
    DEVIN_WEB_DIST_DIR: fixture.daemon ? ".next-daemon-e2e" : ".next-e2e",
    DEVIN_WEB_PORT: fixture.daemon ? "3201" : "3200",
    DEVIN_WEB_HOST: "127.0.0.1",
    DEVIN_WEB_ACPD: fixture.daemon ? "1" : "0",
    // Missing keys can be populated by Next's repository .env files. Empty
    // strings explicitly disable standalone sockets/debug/host additions.
    DEVIN_WEB_ACP_SOCK: fixture.daemon ? join(fixture.state, "acp.sock") : "",
    DEVIN_WEB_HOST_SOCK: fixture.daemon ? join(fixture.state, "host.sock") : "",
    DEVIN_WEB_DEBUG: "",
    DEVIN_WEB_TAILNET: "",
    DEVIN_WEB_ALLOWED_HOSTS: "",
    DEVIN_WEB_PUSH_SUBJECT: "mailto:e2e@example.invalid",
    DEVIN_WEB_ACP_FALLBACK: "0",
    FAKE_ACP_SESSIONS_FILE: join(fixture.root, "sessions.json"),
    FAKE_ACP_SCRIPT: join(fixture.root, "turn-script.json"),
    FAKE_ACP_DB: join(fixture.cli, "sessions.db"),
    FAKE_ACP_STEPS_FILE: join(fixture.root, "steps.json"),
    FAKE_ACP_PID_FILE: join(fixture.root, "agent.pid"),
    FAKE_ACP_PROMPT_LOG: join(fixture.root, "prompts.jsonl"),
  };
}
