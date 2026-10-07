# Security policy

## Report a vulnerability privately

Use GitHub's [private vulnerability reporting form](https://github.com/jihoon22-lee/devin-web/security/advisories/new). Include the affected revision, runtime/CLI versions, prerequisites, impact, and a minimal reproduction using synthetic data. Do not put exploit details, credentials, real transcripts, private hostnames, or database files in a public issue. If the private form is unavailable, open a public issue asking only for a private reporting channel, without vulnerability details.

Security fixes target the current main branch. Older snapshots do not have a guaranteed backport or support window. Do not interpret the absence of published advisories as a security audit.

## Trust boundary

This is a single-user interface with **no built-in application authentication**. A person who reaches it can run commands, answer permission requests, edit files, and control sessions with the service user's authority. Keep the listener on loopback and use a properly authenticated private access layer for remote access. It is not a public multi-tenant service.

Host checks, origin checks, write headers, frame blocking, and image restrictions reduce browser-origin attacks. They do not authenticate users or constrain an already trusted client. A hostname allowlist does not make a public listener safe. Reverse proxies must enforce their own authentication and preserve origin semantics.

Unix sockets are an authority surface: any process running as the same OS user that can reach the agent or terminal socket can drive that agent or spawn/control terminals. Keep the state directory and its sockets owner-only and do not share them with untrusted processes.

`DEVIN_WEB_FS_ROOTS` is an optional lexical filter for selected file APIs. Symlinks, implicitly allowed session directories, and terminal/agent command execution mean it is **not a sandbox**. Use separate OS users, containers, or comparable OS isolation if you need a stronger boundary.

## Private data

CLI databases and web state can contain prompts, responses, tool output, paths, search text, queue attachments, and project work. Logs and `DEVIN_WEB_DEBUG` traffic may contain the same information. Push subscriptions and VAPID private keys are secrets; optional push payloads pass through browser push providers. Exports, screenshots, and browser storage may contain private session details.

Keep these files outside the source repository, back them up with suitable permissions, and redact evidence before sharing. Never upload real state or authentication to a public report. See [operations](docs/operations.md) for consistent backups and [configuration](docs/configuration.md) for remote access settings.

## Dependency checks

Release publication also requires successful CodeQL checks, a processed analysis without errors for the exact candidate commit, and no open high/critical code-scanning alerts on main. Individual findings require code review before dismissal; see the [initial review record](security/codeql-review.md). No query family is disabled.

CI audits the locked dependency graph and rejects high/critical advisories unless an explicit, reviewed development-only exception matches its advisory, package version, dependency path, and expiry. [security/audit-exceptions.json](security/audit-exceptions.json) records the rationale and source for each exception. Exceptions are not a statement that an advisory is fixed; remove them when a supported patched dependency is available or the exposure changes.

The initial exception covers `braces` 3.0.3 through the Next.js ESLint development dependency, expiring **2026-11-06**. The [upstream advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) describes stack exhaustion from deeply nested brace patterns and lists no patched version at the time of review. The reviewed production dependency graph does not include this package; repository-controlled lint patterns run on disposable CI runners without application secrets. This rationale does not extend to runtime use or untrusted input reaching brace expansion. Recheck the production dependency graph when dependencies change.
