# Configuration

## Environment and paths

Export service variables in the shell or service manager that launches `bin/devin-web-ctl`. The wrapper, controller, daemon, and watchdog read their environment before Next.js starts. **A value only in `.env` or `.env.local` does not configure all of these processes.** Keep the same environment for later status, restart, and maintenance commands. When changing an inherited watchdog setting, intentionally stop and start the web supervisor in an idle operational window; daemon settings require a separate idle daemon restart.

For example, using generic paths:

```bash
export DEVIN_WEB_STATE_DIR="$HOME/.local/state/devin-web"
export DEVIN_WEB_PORT=7100
export DEVIN_WEB_DEVIN_BIN=devin
bin/devin-web-ctl start
```

`lib/paths.mjs` resolves the state directory in this order:

1. Nonempty `DEVIN_WEB_STATE_DIR`.
2. `$XDG_STATE_HOME/devin-web`.
3. `$HOME/.local/state/devin-web`.

Use absolute paths for directory and socket overrides. Never share one state directory or daemon connection between independent web instances. The CLI database directory is resolved separately and does not follow `XDG_STATE_HOME`.

**These web overrides do not isolate the real Devin CLI.** `DEVIN_CLI_DIR` selects the database read by devin-web; `DEVIN_WEB_DEVIN_CONFIG` selects the permissions file edited by devin-web. The app does not translate these into CLI data or `--config` arguments. Configure the installed CLI itself using its supported options, verify where it stores data and authentication, and align the web reader/editor with those paths. For real CLI acceptance alongside an active installation, use a verified isolated OS environment or account. Automated tests use the fake CLI fixture harness. Never infer isolation from the web variables alone.

| Variable | Default / meaning |
| --- | --- |
| `DEVIN_WEB_DEVIN_BIN` | `devin`; executable for ACP, version, and authentication probes |
| `DEVIN_CLI_DIR` | `$HOME/.local/share/devin/cli`; Database and session-related files read by devin-web; does not relocate the CLI process |
| `DEVIN_WEB_STATE_DIR` | State resolution above; web-owned DBs, queue, metadata, worktrees, logs, and sockets |
| `XDG_STATE_HOME` | Optional base for the default web state directory |
| `DEVIN_WEB_DEVIN_CONFIG` | Permissions file edited by devin-web; does not pass `--config` to CLI |
| `XDG_CONFIG_HOME` | CLI configuration default is `$XDG_CONFIG_HOME/devin/config.json`, otherwise `$HOME/.config/devin/config.json` |
| `DEVIN_WEB_PORT` | Preferred service port; wrapper CLI `--port` overrides it |
| `PORT` | Port fallback when `DEVIN_WEB_PORT` is absent; otherwise `7100` |
| `DEVIN_WEB_ALLOWED_HOSTS` | Additional accepted Host names, comma-separated, without ports; no authentication is added |
| `DEVIN_WEB_TAILNET` | Optional accepted MagicDNS suffix; unset allows any `*.ts.net` Host name |
| `DEVIN_WEB_FS_ROOTS` | Optional comma-separated file API roots; unset is unrestricted; existing session working directories are also allowed |
| `DEVIN_WEB_ACPD` | Controller defaults to daemon mode; `0` explicitly selects standalone agent ownership |
| `DEVIN_WEB_ACP_SOCK` | Daemon ACP socket; controller defaults to `$STATE_DIR/acp.sock` and passes it to managed web |
| `DEVIN_WEB_HOST_SOCK` | Terminal host socket; controller defaults to `$STATE_DIR/host.sock` |
| `DEVIN_WEB_NO_OPEN` | Any nonempty value suppresses wrapper browser opening; `--no-open` does the same |
| `DEVIN_WEB_DEBUG` | Any nonempty value logs raw ACP traffic; can expose prompts, paths, and tool output |
| `DEVIN_WEB_PUSH_SUBJECT` | VAPID contact URI for optional push; default `mailto:devin-web@example.com` is a placeholder, so set a contact URI you control |
| `DEVIN_WEB_DIST_DIR` | Next build directory, `.next` by default; build and startup must use the same value; E2E uses `.next-e2e` |
| `SHELL` | Shell used for shell-mode terminals; defaults to `/bin/bash` |

`DEVIN_WEB_ACPD_PIDFILE` is an advanced daemon pidfile override. Keep the ordinary `acpd.pid` beside the ACP socket: the controller and passive health checks rely on that convention. Do not set internal detached/restart flags manually. Managed operation must not use `DEVIN_WEB_ACP_FALLBACK` to bypass a daemon failure; fix the daemon or deliberately choose standalone mode.

## Listener and request protection

The wrapper defaults to **127.0.0.1** and does not take a non-loopback host from `HOST`. Changing the listener requires an explicit `--host`/`-H` argument. Port precedence is `--port`/`-p` → `DEVIN_WEB_PORT` → `PORT` → `7100`; an occupied requested port is an error rather than an invitation to silently move the service. The controller binds its managed web to loopback.

Accepted request hosts are loopback names, allowed `*.ts.net` names, and explicit `DEVIN_WEB_ALLOWED_HOSTS` entries. API writes require `x-devin-web: 1` and pass origin/fetch-site checks. Scripts making deliberate API writes need that header. These checks prevent common browser-origin attacks; they do not authenticate a person or isolate users from one another.

`DEVIN_WEB_FS_ROOTS` is a lexical path check using resolved paths. Symlinks can escape a listed root, sessions add their existing working directories, and terminal/agent commands retain the OS user's authority. Use OS-level isolation when you need a sandbox.

## Private remote access

Keep the app bound to loopback and place an authenticated access layer in front of it. With a configured Tailscale installation, a typical private Serve mapping is:

```bash
export DEVIN_WEB_TAILNET="$(tailscale status --json | jq -r .MagicDNSSuffix)"
bin/devin-web-ctl start
tailscale serve --bg --https=7100 http://127.0.0.1:7100
```

This optional example requires `tailscale` and `jq`. Open the HTTPS URL printed by Tailscale. Use tailnet access controls appropriate to the machine's authority; do not publish this service with Funnel or an unauthenticated public proxy. Keep the explicit HTTPS port to avoid replacing an unrelated mapping on port 443. Check your installed Tailscale CLI help for its supported syntax.

For other authenticated proxies, allow only the intended hostname and preserve the browser-facing origin correctly. Proxy settings must support streaming SSE, terminal traffic, and the configured prompt body limit. The app has no multi-user authorization boundary.
