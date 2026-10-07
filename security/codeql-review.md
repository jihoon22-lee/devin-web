# Initial CodeQL review

Reviewed on 2026-10-08 against the initial public source and the first release-preparation PR. These conclusions apply only to the cited implementation and the [documented trust boundary](../SECURITY.md#trust-boundary); review again if authentication, path handling, consumers, or exposure changes. The CodeQL queries remain enabled.

## Path selection: `js/path-injection`

Initial alerts 1–6 cover `stat`/`readFile` in `app/api/fs/read/route.ts`, `stat`/`readdir` in `app/api/fs/list/route.ts`, and `stat`/recursive listing in `app/api/fs/complete/route.ts`.

These are intentional file browsing APIs for the trusted local user. Each entry point resolves the requested path and calls `fsPathAllowed` before accessing it. `lib/fsRoots.ts` applies the configured lexical directory-boundary policy; tests cover traversal, sibling-prefix confusion, and empty session roots. The request guard in `proxy.ts` covers these routes. The reported flow from a user-selected path into filesystem access is expected behavior, not an unauthorized path bypass under this model. These individual findings are classified as false positives for the stated authorization boundary.

This is **not** a claim of sandboxing: unrestricted roots, session-directory roots, symlinks, and agent/terminal commands intentionally allow broader access, as documented in the security policy. Remote users must already be trusted and authenticated by their private access layer. Deploying this unauthenticated interface publicly would invalidate this review.

Initial alert 7 in `app/api/sessions/route.ts` exposed a real ordering problem: directory inspection ran before the configured-root check. An outside-root existing directory returned 403, while an absent path returned 400, revealing existence. The root check now runs before `statSync`; a regression requires the same 403 response and no session creation for both paths. If CodeQL continues reporting the guarded filesystem operation, the remaining user-selected-path flow has the same intentional, lexical-filter interpretation above. The ordering defect itself was fixed, not accepted as an exception.

Validation: the new regression failed before the fix and passed afterward. The filesystem-root, request-guard, and session/worktree route suites passed together (33 tests).

## Heading normalization: `js/incomplete-multi-character-sanitization`

Initial alert 8 concerns the inline-tag removal expression in `bin/check-docs.mjs`. Its output is used only as a heading key in a JavaScript Set to validate local Markdown anchors. It is never rendered as HTML, executed, or used as a security sanitizer. The script reads repository documentation and reports missing links; malformed nested tags can affect a link-check result but cannot introduce the HTML-injection impact described by the query. This finding is a false positive. Do not reuse this heading normalizer for HTML sanitization.

Future high/critical findings must be fixed or individually reviewed with evidence. Release publication rejects open high/critical findings even when the analysis job itself succeeded.
