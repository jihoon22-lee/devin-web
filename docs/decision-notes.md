# Decision notes

These notes explain current implementation rules without carrying private operational history into the public repository. [AGENTS.md](../AGENTS.md) is the active contributor contract; [architecture](architecture.md) explains the whole system. Retired event-mirror/replay designs are not current protocols.

## Verification and deployment

Verification covers both the app and daemon type layers, unit tests, and lint. A build rewrites the selected Next output directory and needs a matching web restart. Separate process groups let the managed agent survive that restart. Detached controller re-drive prevents a restart command launched inside the old web process tree from dying halfway through. It does not make a full daemon stop safe for running turns.

## State paths and runtime

`lib/paths.mjs` centralizes environment/XDG/home precedence; Bash startup must mirror it. Derived app paths stay lazy for isolated tests, while entry points freeze paths at startup. The supported runtime is Node.js ≥24.18.0 and <25, with pnpm 9.15.9. Keep explicit daemon-layer typechecking even where newer Node versions can load additional syntax.

## Search jumps

A supplied node ID is authoritative. Falling back to equal text can silently jump to another occurrence. Only targets without node IDs may use provisional text anchors. Older-history jumps use a bounded 20-page search; a missing target must remain missing rather than matching unrelated text.

## Logs supervision and streams

A `connId#tag` identifies a particular stream incarnation; a late close from an old connection must not detach its replacement. `web.disabled` distinguishes an intentional stop from a crash. Logs and integrity counters help diagnose failures but can include private identifiers and must be redacted before publication.

## ACP values and session view

A fresh snapshot replaces metadata and regions as one authoritative value. Contiguous patches may resume a reconnect, while gaps require snapshots. `clearMeta` makes removals explicit because JSON drops undefined fields. Nullable event data and untyped metadata are protocol inputs, so validate before committing a version. Loading a live daemon-adopted session can disrupt its turn; use view snapshots and transcript pages to populate the browser.

## Turn regions and retention

Durable, provisional, retained, and overlay content have distinct owners. Text equality cannot establish identity: repeated text is valid user data. Server assembly assigns provisional IDs; `TurnRegions` finalizes the spine and `alignSpine` anchors counterpart-less thoughts/plans. Tools align by exact ID, text by role ordinal, and anchors remain inside the completed turn. Retention is bounded to 20 turns in memory and itemlog. Finalization includes the latest assembler state in one transaction. A failed alignment or write preserves recovery state; do not let a new turn overwrite it. ACP completion does not acknowledge the SQLite commit: preserve ended agent content until durable progress permits finalization. Empty/user-echo-only endings do not need a commit. Hold subsequent prompts in the persisted queue with autonomous backoff retries; an uncommitted error/cancel turn cannot safely be discarded merely to unblock the next prompt.

Retained data travels on structural transitions, snapshots, and transcript responses. Omitting it on frequent flushes preserves the existing retained list. Restored provisional regions use boot-scoped turn IDs and newer item revisions. Client integrity checks are regression alarms; the open observation work is tracked in the [roadmap](roadmap.md).

## Frozen watermark and graft seeds

Freeze durable coverage at turn start, including daemon adoption. Otherwise mid-turn CLI commits and provisional descriptions render twice. A graft edge crossing the watermark is needed internally to discover eligible history; clip it before display rather than removing it before expansion. Nested grafts, null-root compaction, explicit heads/branches/segments, and pagination need the same canonical ordering and watermark rules.

## Web and client safety

Every detached promise owns its rejection handler. A process-level log-and-survive guard prevents a full outage but does not excuse escaped errors. Crash-safety tests must observe those escapes. Poisoned frames cannot advance committed view versions, and item boundaries contain individual rendering failures.

Queue ghosts derive from persisted queue state; real user bubbles appear only when drained content reaches assembly. Deletion pauses draining and preserves the queue on failure. A deleted object's late completion cannot revive a replacement. Older pagination responses can extend only durable content within the current watermark and cannot overwrite retained view state.

## Transcript grafts and cursors

Compaction can create null-parent roots or graft a continuation onto an earlier node. Gap segments must splice recursively in display order without duplicating live-chain members. A cursor at a graft child resumes through its dead tip. Message rewrites use canonical final positions, and already-expanded rows must not be re-walked through parent links. `truncated` reflects earlier-node existence rather than page fullness. Explicit head, branch, and bounded work-history segment queries select different scopes.

## Tree index

Store parent links and per-session row cursors in `treecache.db`. Recursive forest membership avoids stale per-row root labels on long chains. Keep the indexed `CROSS JOIN` query shape; superficially equivalent joins can create expensive scans. Catch-up and main-chain movement both invalidate cached summaries.

## Fork at node

Capability names and ACP method names differ: advertise `cognition.ai/revert`, call `_cognition.ai/revert/listSteps` and `forkFromStep`. Refuse unsupported requests. The fork target is the smallest covering step, or the newest available step, followed by loading the newly created fork. A cached daemon initialization may require an idle restart to advertise newly supported capabilities.

## Test environment and fs roots

Tests clear inherited daemon sockets and point state/CLI paths at per-file temporary fixtures. React `act` requires the development environment used by the test command. Empty configured root lists mean unrestricted, but an empty list of implicit session roots must never widen an explicitly configured gate.

## Daemon wire and ownership

Socket traffic can adopt a new client, so passive liveness uses pidfiles and `kill(0)`. Agent text-file operations remain serviceable in the daemon until a web client is initialized. Async replies belong to their original requester. JSON-RPC null results are legal; malformed lines must not terminate the daemon. The hello notification precedes a first response, so match response IDs rather than reading one line.

A busy probe may speak only when the daemon status lacks a connected client; HTTP failure alone does not establish that. Stop must destroy all accepted sockets, including silent connections, before waiting for the server to close. Daemon/host changes activate only through a scheduled idle daemon restart.

## Sequence and request ownership

Item sequence revisions and view versions are separate spaces. Restore persisted provisional/retained sequence maxima before allocating fresh events; reconciled tool completion updates require newer revisions. Request IDs include randomness, and responses/cancellation are bound to the route session so another session cannot answer a permission card.

## Terminal host and backpressure

PTY ownership stays in the daemon. Absolute offsets prevent duplicate terminal output on snapshot replay. Delayed RPC replies must remain on their original socket, and every host reconnect sends `sessions/state`. On a false socket write, pause upstream and arm exactly one drain listener; dropping a dead socket must release the paused source because that socket will never drain.

## Hermetic E2E

Browser verification uses production builds in `.next-e2e` or `.next-daemon-e2e`, isolated CLI, state, home, and configuration directories, and a scripted fake ACP agent. The managed restart suite owns a separate daemon and real PTY. It does not use live sessions or the development server's HMR behavior. A TCP proxy severs established EventSource connections reliably. Per-spec session IDs and a single worker avoid fixture cross-talk. Wait for rendered output before shortcuts and give icon-only controls accessible names.

## Database cursors and search

Explicitly close every CLI DB handle. Cache durable maxima per database commit with invalidation and a missed-watcher backstop; a stale-high watermark can leak duplicate live content. Keep request queries indexed and bounded; move expensive aggregation to incremental cache work.

Stable search identity is `(session_id,node_id)`, not a mutable source row ID. Rewrites delete stale index copies, source rollback invalidates cursors, and migrations update their version marker transactionally. Invalidate only affected metadata so recycled FTS IDs cannot keep stale mappings. Do not truncate source text to reduce cache size; use deduplication and compaction. An unreadable source must leave migration work retryable.

## CLI schema health

Fingerprint the tables and columns actually read. A missing optional migration history makes the version unknown; missing required columns mean drift. Other open/query failures mean unavailable, never compatible. Close the probe handle and cache the result for five minutes. Expose the distinction in both health API and UI diagnostics.

## Worktrees and archive

Worktree sessions use fresh HEAD-based branches and real worktree directories as their cwd. Path-keyed hints are re-statted before load/save so another controller's removal is not resurrected. Session deletion leaves worktrees for explicit review. Git's dirty-worktree refusal should reach the user unchanged. Archiving writes web-owned JSON and preserves transcript/search/direct-link access; it never modifies CLI-owned `sessions.db`.

## Git paths and mentions

Porcelain paths are literal names, including brackets and wildcard characters. Mutating Git commands use `--literal-pathspecs` to avoid touching unrelated files. Resource links use URI encoding; older queue records without an encoding version keep literal percent sequences. Editable previews, stored ACP links, and drain payloads must respect their distinct representations. Prompt/proxy body limits share `lib/limits.ts` so oversized requests fail predictably.

## IME

Enter can commit an IME composition rather than submit a form. Inline Enter handlers start with `isImeComposing(e)` and return early. Keep the automated handler audit when adding controls.
