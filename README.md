# devin-web

[![CI](https://github.com/jihoon22-lee/devin-web/actions/workflows/ci.yml/badge.svg)](https://github.com/jihoon22-lee/devin-web/actions/workflows/ci.yml)

[한국어](README.ko.md) · [Getting started](docs/getting-started.md) · [Documentation](docs/README.md)

A self-hosted browser interface for [Devin CLI](https://devin.ai), with streaming conversations, permission prompts, project files, Git changes, and real terminals. Resume local CLI sessions from a desktop or phone. Managed mode keeps the agent and terminals alive across web restarts.

This is an independent community project, not an official Cognition or Devin product. Devin CLI is installed and authenticated separately; its service terms and charges still apply.

## Start

Supported environment: **Linux, including Linux inside WSL**, **Node.js ≥24.18.0 and <25**, **pnpm 9.15.9**, and an authenticated `devin` on `PATH`. Native PTY installation may need Python 3, make, and a C/C++ compiler. See [prerequisites and WSL setup](docs/getting-started.md).

```bash
git clone https://github.com/jihoon22-lee/devin-web.git
cd devin-web
pnpm install --frozen-lockfile
devin auth status
pnpm build
bin/devin-web-ctl start
```

Open [http://127.0.0.1:7100](http://127.0.0.1:7100). Installation and build also work from a source archive without Git; Git is required for contributor verification and Git features. The first build downloads Geist fonts from Google Fonts.

For development, use `pnpm dev`. For a foreground production web process, use `pnpm start` after building. The [managed service](docs/operations.md) is recommended for ongoing use; `pnpm start` alone does not start the daemon or supervisor.

## What you can do

- Browse, search, tag, archive, resume, and fork CLI conversations.
- Follow messages, plans, tool output, usage, and permission requests as they arrive.
- Queue prompts, attach images, mention files, and edit or remove queued work.
- Review project files and Git diffs, stage changes, and commit from the browser.
- Open real terminals, reconnect to surviving sessions, and use a touch key bar on phones.
- Use light/dark themes, a PWA, optional device push notifications, and keyboard shortcuts.

There is **no application login**. Anyone with access to this UI can act as your OS user, including running shell commands. Keep the listener on loopback and use an authenticated private access layer for remote devices. Host and CSRF checks are request defenses, not user authentication. Read [security](SECURITY.md) before enabling remote access.

## Documentation

[Usage](docs/usage.md) · [Configuration](docs/configuration.md) · [Operations, updates, and backups](docs/operations.md) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md) · [Roadmap](docs/roadmap.md)

```bash
pnpm verify                         # typechecks, unit tests, lint; Git required
pnpm exec playwright install chromium
pnpm exec playwright test           # isolated fixture and build, no real sessions
```

MIT for project-owned code and documentation. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md) for assets and dependencies under their own licenses.
