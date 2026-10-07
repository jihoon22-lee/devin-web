# Roadmap

This list records remaining engineering work carried into the public project. It is not a release promise. Public issues should link back to these entries and use synthetic or redacted evidence.

## Observe retained-anchor and duplicate integrity alarms

Tracking origin: **R17 D4**. The session-load replay fix is implemented; longer observation of `orphanAnchor` and duplicate alarms remains open. A short clean run or zero counters immediately after restart does not close this item.

Collect component versions, reconnect/turn-finalization timing, view versions, region counts, and anonymized anchor geometry when a recurrence occurs. Preserve the distinction between synthetic regression coverage and observed running-system behavior. Reproduce any new mechanism in an isolated fixture, then define an observation period and explicit closure criteria. Never attach live session IDs, conversations, or raw database/log files to a public issue.

## Extract stateful queue lifecycle methods

Tracking origin: the remaining **R17 D3** follow-up. Pure preview helpers already live in `lib/acp/queuePreview.ts`; stateful methods remain coupled to `ActiveSession` and turn lifecycle in `manager.ts`.

An extraction must retain queue persistence and attachment blobs, adoption hydration, turn-end draining, edit/drop behavior, failed-deletion recovery, deleted-session protection, and boot-scoped identities. Establish those contracts in regression tests before moving ownership. This is a refactor, not a reason to change queue behavior or its on-disk encoding.
