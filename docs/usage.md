# Using devin-web

## Sessions and prompts

The sidebar lists CLI sessions grouped by project directory. Create a session in a working directory you own; an isolated Git session creates a separate worktree. Existing CLI sessions can be resumed in the browser. Sessions held by another CLI process open read-only; **Take over** changes ownership, so use it only when you intend to move that session away from its current CLI.

Choose mode and model from the controls offered by your CLI. Send a prompt, attach images, or use `@` to mention files. Image limits are 10 MiB each and 40 MiB total attachments; an oversized prompt is rejected. Mode and model availability depend on the installed CLI and its capabilities.

During a turn, prompts can be queued. Inspect, edit back into the composer, or drop queued entries; the queue is bounded by entry count and serialized size. Queue text and larger attachment blobs are saved in the state directory. **Stop** interrupts the current turn; use the accompanying queue option when you also intend to discard queued work.

Permission cards allow or reject a tool action. Read the command, path, and diff before approval. An “allow always” grant is a persistent CLI rule; Settings can revoke those grants. A running agent may keep rules it already loaded until it is restarted during an idle maintenance window. Questions from the agent render as inline forms.

## Find and organize

Use the sidebar filter, tags, pins, and needs-input filter to organize sessions. Archive hides a session from the active sidebar while preserving direct links, search, and transcripts. Deleting a session is different: it requests deletion through the agent and clears its web state. Deleting a worktree session leaves the worktree on disk for separate review and removal.

`Ctrl+K` opens session and transcript search. Search accepts at least two characters; terms of three or more use a trigram index, with a substring path for shorter terms. Filter by project, age, or tool output. Selecting a result jumps to its node; older history loads as needed within a bounded search window. The in-session Find view also exposes a prompt outline.

History and fork controls depend on CLI capabilities. A fork at a message uses the CLI step covering that node, so it may include the rest of that step. Forking creates a new session. Export supports Markdown and JSON; treat exports as private conversation data.

## Files, changes, and terminals

**Files** browses the session directory and lets you read, copy, download, and mention files. The optional filesystem root setting limits selected file APIs lexically; it is not a sandbox for agent commands.

**Changes** shows Git status and diffs against `HEAD`. Review individual files, stage or unstage, revert, and commit the staged set. Revert saves the previous working bytes for a temporary **Undo revert** action (10 minutes); this is not a backup system. A non-Git directory can still host a session but has no Git changes view. Review comments on diffs can be sent into the conversation.

**Terminals** includes agent command terminals and user shells. In managed mode, PTYs and their scrollback live in the daemon and survive web restarts. User shells can expire after 30 minutes idle when unobserved; **Keep open** prevents idle cleanup. Closing the web tab is not the same as terminating a shell. On touch devices, use the auxiliary key bar for Escape, Tab, Control, arrows, and interrupt keys. **Fit here** lets the current viewer control terminal size.

## Devices and health

Theme and notification settings are available in Settings. Browser notifications and Web Push require permission; enable push separately on each device. Push support depends on the browser and a secure origin. On iOS, use the installed home-screen web app for push. Push payloads can include session titles and status text and are delivered through the device browser's push provider.

The health badge opens diagnostics for the CLI, agent, terminal host, schema compatibility, storage, and transcript integrity. A green HTTP response alone does not prove the CLI is authenticated or the agent is usable. See [operations](operations.md#diagnostics-and-recovery) for component failures.

Press `?` to inspect available keyboard shortcuts. Permission shortcuts only work outside form controls. The sidebar and side panels adapt to phone and desktop layouts; desktop side panels can be resized.
