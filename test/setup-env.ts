// The web server hands DEVIN_WEB_ACP_SOCK / DEVIN_WEB_HOST_SOCK to its
// children — an agent's exec shell inherits them. Tests must never see
// them: they flip bridge.socketMode and swap terminalPool for the remote
// facade at import time. Runs before every test file (vitest setupFiles).
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

delete process.env.DEVIN_WEB_ACP_SOCK;
delete process.env.DEVIN_WEB_HOST_SOCK;
// Per-file tmpdirs keep default state/CLI path resolution away from real
// user state; a test file that sets these at its own top still wins (its
// assignment runs later than this setup file).
process.env.DEVIN_WEB_STATE_DIR = mkdtempSync(join(tmpdir(), "dw-test-state-"));
process.env.DEVIN_CLI_DIR = mkdtempSync(join(tmpdir(), "dw-test-cli-"));
// the CLI's user config ("allow always" rules) — never the real one
process.env.DEVIN_WEB_DEVIN_CONFIG = join(mkdtempSync(join(tmpdir(), "dw-test-cfg-")), "config.json");
