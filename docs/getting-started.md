# Getting started

## Prerequisites

Use Linux, either directly or inside WSL. Native Windows and macOS service management are not supported: the controller uses Bash, Unix sockets, Linux process groups, and Linux process tools. In WSL, install Node, pnpm, Devin CLI, and the repository inside the Linux environment; keep existing Linux project paths usable rather than moving them to Windows. Windows can normally open the forwarded localhost address in its browser; WSL networking configuration can affect that forwarding.

Required:

- Node.js **≥24.18.0 and <25**, which supplies the SQLite API used by the app.
- pnpm **9.15.9**, matching `packageManager` and the committed lockfile.
- Devin CLI installed through its official distribution and authenticated as the user who runs this service. `devin --version` and `devin auth status` should succeed. The initial release was exercised with Devin CLI **3000.11.3**; inspect the health badge for schema compatibility when using another CLI version.
- Bash, curl, and common Linux tools. Managed operation uses `setsid` (util-linux), `ss` (iproute2), `ps`/`pgrep` (procps), and GNU coreutils/grep.
- For native `node-pty` compilation: Python 3, make, and a C/C++ compiler. On Debian/Ubuntu these are typically supplied by `python3` and `build-essential`.
- Git for cloning, `pnpm verify`, worktree creation, and the Changes tab. Installation, build, and ordinary session usage from a source archive do not require Git.

Use a Node version manager or your preferred installation method. With a Corepack-enabled Node installation, `corepack enable` and `corepack prepare pnpm@9.15.9 --activate` select the pinned pnpm. If Corepack is unavailable, install pnpm 9.15.9 using its supported installation method, then check `node --version` and `pnpm --version`.

## Install and run

```bash
git clone https://github.com/jihoon22-lee/devin-web.git
cd devin-web
pnpm install --frozen-lockfile
devin auth status
pnpm build
bin/devin-web-ctl start
```

For a source archive, extract it, enter the extracted directory, and start with `pnpm install --frozen-lockfile`. The hook installer skips directories without Git metadata. Do not disable package installation scripts: native dependencies need their installation steps.

The build downloads Geist and Geist Mono via `next/font/google`. Allow build-time access to Google Fonts; the completed application serves the downloaded font assets locally.

Open [http://127.0.0.1:7100](http://127.0.0.1:7100). Check `bin/devin-web-ctl status` and the UI health badge. A fresh CLI installation may have no previous sessions; create one in a directory you own and send a small prompt. If authentication is missing, complete authentication with Devin CLI outside the browser, then refresh the health status.

## Choose a mode

| Command | Behavior |
| --- | --- |
| `pnpm dev` | Wrapper with explicit `--dev`; development server and standalone agent unless sockets are explicitly configured |
| `pnpm build` then `pnpm start` | Foreground production web; requires a completed build; no managed daemon or supervisor startup |
| `pnpm build` then `bin/devin-web-ctl start` | Recommended managed service: web, persistent agent/terminal daemon, and web supervisor |

A standalone agent belongs to the web process and does not survive its restart. Managed mode keeps that agent in `devin-acpd`. Do not point multiple web instances at the same daemon sockets or state directory. Use separate state and CLI fixture directories for tests.

The wrapper is also available directly:

```bash
node bin/devin-web.mjs --help
node bin/devin-web.mjs --dev --port 7200 --no-open
```

The default listener is `127.0.0.1:7100`. Port precedence is `--port`, `DEVIN_WEB_PORT`, `PORT`, then `7100`. Use the same exported port when invoking the controller later. Production does not silently switch to development if the build is missing.

Read [configuration](configuration.md) before remote access and [operations](operations.md) before updating an active installation.
