# Third-party notices

The root [MIT license](LICENSE) covers project-owned code and documentation. Third-party software and assets retain their own copyright and license terms. This source repository does not vendor installed dependencies or build output. Installing dependencies or redistributing an application build brings the licenses of those dependencies and bundled assets with it; preserve their notices.

## Icons

The UI imports icons from [`lucide-react`](https://github.com/lucide-icons/lucide), installed through pnpm. Lucide's ISC license includes a separate MIT notice for icons derived from Feather. The complete notice from the installed dependency is preserved in [lucide-LICENSE.txt](docs/licenses/lucide-LICENSE.txt), including both copyright statements and the upstream list of derived icons.

`app/icon.svg`, `app/apple-icon.png`, and `public/icon-192.png` / `public/icon-512.png` are the repository's terminal-mark application assets and are covered by the project license. They do not use Devin or Cognition brand artwork. The name Devin identifies the external CLI integration and does not imply endorsement or grant trademark rights.

## Fonts

`app/layout.tsx` uses **Geist** and **Geist Mono** through `next/font/google`. The source checkout has no bundled font binaries; the build downloads font files and Next.js serves them as application assets. Both Google Fonts distributions are licensed under **SIL Open Font License 1.1**, with copyright credited to The Geist Project Authors.

Preserved full licenses and their primary sources:

- [Geist OFL](docs/licenses/geist-OFL.txt), from [Google Fonts: Geist](https://github.com/google/fonts/blob/main/ofl/geist/OFL.txt).
- [Geist Mono OFL](docs/licenses/geist-mono-OFL.txt), from [Google Fonts: Geist Mono](https://github.com/google/fonts/blob/main/ofl/geistmono/OFL.txt).

The upstream project is [vercel/geist-font](https://github.com/vercel/geist-font). Font software remains under OFL; the project MIT license does not relicense it.

## Installed packages and external tools

Next.js, React, xterm.js, node-pty, Markdown/highlighting libraries, web-push, and other packages are installed from the committed pnpm lockfile. Their authoritative license files ship with their packages in `node_modules`; this file is not a substitute for those licenses or an exhaustive build artifact bill of materials. Preserve applicable package notices if distributing bundled JavaScript, native modules, or other compiled output.

Devin CLI, Node.js, pnpm, Git, and optional Tailscale/Playwright browser binaries are separate installations. They are not included or relicensed by this repository. Do not add their binaries, authentication, or runtime data to a source release.

When introducing copied source or new assets, record the origin, applicable version, license, and required full notice here before distribution.
