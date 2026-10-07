# Operations

Run commands from the installed source directory with the same exported environment used at startup. In this guide, `$STATE_DIR` means the resolved state directory described in [configuration](configuration.md); it is not an automatically exported shell variable.

## Managed lifecycle

```bash
bin/devin-web-ctl start
bin/devin-web-ctl status
bin/devin-web-ctl restart
bin/devin-web-ctl stop
bin/devin-web-ctl acpd status
```

Managed mode uses three pieces: the web process, `devin-acpd` (agent and PTYs), and `devin-web-watch` (web supervision). `restart` replaces only the web; a healthy daemon's running turns and terminals survive. `stop` intentionally stops the web and disarms its watchdog through `web.disabled`; `start` re-arms it. The controller detaches a restart invoked from inside its own process tree so it can finish after the old web exits.

Production start and restart validate dependencies and a completed build. A missing build does not turn into a development server; failed validation must leave the existing web running. Daemon startup failure is an error, not permission to spawn a competing standalone agent. `DEVIN_WEB_ACPD=0` is the explicit standalone choice and makes active turns vulnerable to web restart.

Do not use `stop --all`, `restart-all`, or a forced daemon restart while turns are running. They stop the agent and PTYs. A daemon restart is needed for changes in `bin/devin-acpd.mjs`, `lib/acp/daemon.mjs`, or `lib/acp/host.mjs`, and for daemon-inherited environment changes:

```bash
bin/devin-web-ctl acpd restart --when-idle
```

This schedules the restart at an all-idle gap. It does not preserve idle user shells: PTYs still end when the daemon restarts. Finish shell work first. The idle watcher logs decisions to `acpd-watch.log`.

Managed process control uses Linux `/proc` identity records alongside the numeric PID files (`*.identity.json`). The controller checks boot ID, process start time, executable/arguments, group/session and launch configuration before treating a process as owned. A live PID with missing or mismatched identity is left untouched and the operation fails. Lifecycle changes are serialized with `flock`; detached services do not retain the controller lock. Managed launches record separate `.launch` ownership before application initialization; a failed start cleans up only its unique launch token, and another start is refused while initialization is pending. Shutdown snapshots verified descendants in the owned group and checks each process identity again before TERM or KILL, including children that outlive their leader; it never sends a negative-PGID signal. `/proc` validation and the following PID signal are separate system calls, so this is not an atomic kernel pidfd guarantee. Processes whose identity changes are left untouched. Use the same installation directory and exported configuration for lifecycle commands; changing the configured port, build directory or daemon sockets requires stopping the old configuration first.

When upgrading a running installation that predates identity records, explicitly register its existing processes before invoking the new controller. From the existing installation directory, export its actual startup environment (including `DEVIN_WEB_STATE_DIR` and any custom port/socket settings), inspect the PID files, then register each live component:

```bash
node bin/process-identity.mjs adopt "$DEVIN_WEB_STATE_DIR/pid" web
node bin/process-identity.mjs adopt "${DEVIN_WEB_ACPD_PIDFILE:-$DEVIN_WEB_STATE_DIR/acpd.pid}" acpd
node bin/process-identity.mjs adopt "$DEVIN_WEB_STATE_DIR/web-watch.pid" watch
# Only if an idle-restart watcher is already armed:
node bin/process-identity.mjs adopt "$DEVIN_WEB_STATE_DIR/acpd-idle-restart.pid" idle
```

Adoption validates the live process's script path, installation root, state directory and configuration before recording its identity; it sends no signals and makes no socket connections. Omit absent components. Resolve any mismatch instead of deleting a live PID file. Until registration finishes, an old watchdog still checks health but a recovery call into the new controller can refuse unverified ownership. Complete registration promptly while the existing services are healthy. Moving to another installation directory requires an idle maintenance window for the daemon as well: ownership is bound to the original source directory.

## Manual updates

There is no automatic source updater. In a Git checkout, first review local changes and the intended upstream revision. Back up user state before a change that may affect storage.

```bash
git status --short
git pull --ff-only
pnpm install --frozen-lockfile
pnpm verify
pnpm build
bin/devin-web-ctl restart
```

`pnpm verify` is safe while the production server runs and requires Git for its Git fixtures. `pnpm build` rewrites `.next`; promptly restart the web after a successful build. Use an idle maintenance window to minimize asset mismatches during the build. Tests and builds do not prove that the deployed CLI is authenticated or compatible; check the UI health dialog and a normal session after restart.

For a source archive installation, obtain the new source archive from the repository, keep runtime state outside the source directory, and install/build in the new directory. Contributor verification needs Git. Process ownership is bound to the installation path: moving directories requires an all-idle maintenance window even when the daemon protocol is compatible. Finish terminal work, use the controller in the old directory to stop the supervisor, web and daemon (`stop --all`), then start the new controller with the same exported settings and state directory. This path change ends daemon-owned terminals. Never run the old and new watchdogs concurrently against the same state directory.

Web-only updates leave the daemon executing its previous loaded code. If an update changes the daemon or the web/daemon protocol, read the change notes and schedule its idle restart before treating the update as complete. Retain a known-good source revision and the corresponding lockfile for rollback.

## Diagnostics and recovery

Start with the UI diagnostics dialog, `bin/devin-web-ctl status`, and `GET /api/health`. The health response includes agent transport/liveness, host connectivity, CLI login/version, schema compatibility, storage, stream statistics, and integrity counts. HTTP 200 and `ok: true` describe the endpoint, not the health of every component. In standalone mode the agent may be absent until a session attaches.

| Symptom | First checks |
| --- | --- |
| Startup refuses a missing build or dependency | Confirm the supported Node/pnpm versions, run frozen install and build, then retry; keep the prior service running until validation succeeds |
| Port already occupied | Inspect the listener and owning process; choose the intended port or stop the known owner; do not kill an unidentified process |
| CLI not found or logged out | Check `DEVIN_WEB_DEVIN_BIN`, exported `PATH`, OS user, and `devin auth status` |
| Host rejected (421) or write rejected (403) | Check hostname allowlist, proxy Host/origin handling, and write headers; do not disable request protection |
| Daemon down, degraded, or orphaned agent detected | Read `acpd.log` and `acpd-status.json`; preserve running work, identify ownership, then recover during an idle window |
| CLI schema drift/unavailable | Check the reported CLI version and required columns; do not modify the CLI database schema to suppress the warning |
| Empty/stale transcript or reconnect failures | Inspect `[stream]`, `[diag]`, and `[integrity]`, then capture a sanitized reproduction; do not reload a live daemon session through ACP merely to seed the UI |
| Prompt stays queued while the previous transcript is not ready | Automatic retries continue without an open browser. Check storage availability and finalization errors. Retrieve or edit the queued prompt, or continue in a new session if recovery is delayed. Do not delete `itemlog.db` or force a new turn over the preserved previous region |
| Web remains stopped after an intentional stop | Run `ctl start` to re-arm supervision; `web.disabled` is intentional |
| Search cache is large or inconsistent | Run `bin/devin-web-ctl search-compact` during low activity; it rebuilds/vacuums the web search cache |

The controller refuses obvious orphan-agent conflicts. An override is not a normal recovery procedure: a second agent can compete for session locks. Read pidfiles/status files for passive daemon diagnosis; a manual socket probe can become the current client and displace the web connection.

Logs live in the state directory:

- `server.log`: web events, `[stream]`, client `[diag]`, transcript `[integrity]`, and absorbed `[fatal]` errors.
- `acpd.log`: agent and daemon events.
- `web-watch.log`: web supervision and recovery.
- `acpd-watch.log`: scheduled idle restart decisions.

Large managed server/daemon logs rotate with one prior generation. The watchdog also checks their size while running. `[fatal]` remains a bug even when the last-resort guard kept the process alive. Integrity counts reset with a web process restart; a fresh zero is not proof a regression has disappeared. The [roadmap](roadmap.md) tracks ongoing retained-anchor and duplicate observation.

## Data ownership and backups

The CLI owns `$DEVIN_CLI_DIR/sessions.db`, its sidecars, and session artifacts. devin-web reads that database; session changes go through ACP. The web owns its own state directory:

| Data | Backup/recovery significance |
| --- | --- |
| `itemlog.db` | Provisional/retained turn content and selected metadata; needed for restart fidelity |
| `prompt-queue.json`, `queue-blobs/` | Queued user prompts and attachments; preserve together |
| `tags.json`, `archive.json`, `ui-state.json` | User organization and preferences |
| `worktrees.json`, `worktrees/` | Worktree hints and real Git work; may contain uncommitted user files |
| `vapid.json`, `push-subs.json` | Private push key and device subscriptions; keep confidential |
| `revert-trash/` | Temporary file revert recovery; not a durable backup |
| `search.db`, `treecache.db` | Rebuildable search/tree caches, still containing private source data |
| Logs, sockets, pidfiles, status and disable markers | Runtime operations; do not restore stale sockets or pidfiles as live state |

Also preserve project repositories and their linked worktree metadata, and any CLI configuration you need to recover. Worktrees are tied to their source Git repositories; copying only the worktree directory is not a portable repository backup.

For SQLite files that are being written, use SQLite's online backup API or a storage snapshot coordinated across the database and its WAL sidecars. Copying only a live `.db` file can lose committed WAL data. A complete cross-file backup is easiest during a planned **idle** maintenance window: wait for every turn and queued prompt to finish, close valuable shells, stop writers, back up CLI and web state plus project files, then restart with the same configuration. Do not stop active turns just to take a backup. A live backup may be per-file consistent without representing one application-wide point in time.

Store backups outside the source tree with owner-only permissions. Do not upload state, logs, screenshots, tokens, or unredacted exports to GitHub. For restore, stop writers only after work is idle, preserve the damaged copy for diagnosis, restore data with the correct owner and permissions, and exclude old sockets/pidfiles. Rebuild caches if needed. Review restored queues before reattaching sessions: queued prompts can resume automatically. Validate session history, queue contents, permissions, worktrees, and push configuration before resuming normal use.

## Rollback

If a web update fails, preserve the diagnostics, return to the known-good source revision and lockfile, reinstall dependencies, rebuild, and restart only the web. Do not reset or delete the CLI database as a rollback step. A code rollback may not understand newer state formats; use the release's compatibility guidance and the matching backup when required. If a daemon update is implicated, schedule rollback of that component during an idle gap. Never force-kill a working agent to make the health badge green.
