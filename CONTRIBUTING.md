# Contributing

Use issues for reproducible bugs and focused feature proposals. Report vulnerabilities privately using [SECURITY.md](SECURITY.md). Keep changes scoped enough to review, and explain the user-visible behavior and validation in the pull request.

## Development environment

Follow [Getting started](docs/getting-started.md): Linux/WSL Linux, Node.js ≥24.18.0 and <25, pnpm 9.15.9, Git, and native PTY build prerequisites. Clone the repository rather than using a source archive for contributor verification: Git tests create temporary repositories.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` explicitly selects the development wrapper. Use the fake CLI harness for concurrent testing and separate all state, home, config, sockets and fixture paths; never connect a test/development web to the production daemon's sockets. Web path variables alone do not isolate real CLI data, credentials or permissions. Real CLI testing requires its own verified configuration or OS-level isolation; see [configuration](docs/configuration.md#environment-and-paths). A source archive can install/build/run without Git, but that is not a replacement for the contributor test suite.

Read [AGENTS.md](AGENTS.md) before changing implementation invariants. This repository's installed Next.js version includes its own guides under `node_modules/next/dist/docs/`; consult the relevant guide before relying on framework API knowledge. Keep the generated Next.js instruction block.

## Required checks

```bash
pnpm typegen                       # generated Next types on a fresh checkout
pnpm verify
pnpm docs:check
pnpm public:check
node bin/check-audit.mjs
pnpm build
```

`verify` typechecks the TypeScript app and JavaScript daemon layers, runs Vitest, and lints. It does not rebuild a live `.next`. `build` does overwrite the default build directory; follow [operations](docs/operations.md) when working in an installed checkout. `pnpm check` combines verification and build.

`pnpm install` installs a local pre-push hook when Git metadata is present, preserves a differing existing hook, and skips source archives. The hook runs `pnpm verify`; if you bypass it or already use another hook, run verification explicitly for the exact change being pushed. CI is an additional check, not a substitute for the requested local evidence.

For user-flow, reconnect, and responsive changes, run the isolated browser suite:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:daemon                    # managed web restart with isolated daemon + PTY
```

On a minimal Linux environment, Chromium may require system libraries; use Playwright's documented dependency setup for your distribution. The ordinary E2E suite generates `.e2e-fixture/` with a fake CLI/database and builds `.next-e2e`. The daemon suite uses `.daemon-e2e-fixture/` and `.next-daemon-e2e`, with its own daemon, agent fixture, and real PTY to verify web restart continuity. It never needs your real CLI authentication. Keep one fixture session per spec and the configured single worker. Do not replace the fake with a live agent or real database. Established SSE connections must be severed through the test proxy, not only browser offline emulation.

`bin/check-audit.mjs` fails unreviewed high/critical advisories and honors only the explicitly scoped, expiring development exceptions in [security/audit-exceptions.json](security/audit-exceptions.json). Do not report that as a zero-advisory audit. See [the security policy](SECURITY.md#dependency-checks).

Add regression tests for changes to transcript identity/order, queue ownership, permissions, persistence, daemon transport, or restart behavior. UI changes should cover the relevant phone/desktop workflow and keyboard/IME behavior. Preserve synthetic evidence of failures until the corrected scope has been verified.

## Public contribution hygiene

Only commit source, configuration examples, and synthetic fixtures. Exclude `.env` files, state directories, logs, screenshots of live sessions, credentials, push keys/subscriptions, session IDs, private hostnames, user home paths, and production database copies. Test fixtures must be invented or anonymized. Review staged content and generated files before pushing.

Do not vendor installed dependencies, generated builds, browser profiles, or downloaded tools. Preserve third-party license notices for copied code, fonts, and icons; update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when attribution changes. Project contributions are accepted under the repository's MIT license; third-party material keeps its original license.

## Pull requests

Describe the trigger, previous behavior, new behavior, and any migration or restart requirements. List checks actually run and failures or unverified areas honestly. For daemon changes, call out the idle restart requirement; for web-only changes, do not imply that an agent restart is needed. Use public synthetic screenshots only when they help reviewers. Update the English detailed guide and both English/Korean entry guides if startup behavior changes.
