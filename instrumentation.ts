/** Process-level last line of defence for the web server.
 *
 *  devin-acpd has logged-and-survived uncaught exceptions since it was
 *  written (bin/devin-acpd.mjs) — the web process never got the same
 *  treatment, so a single stray rejection anywhere in the async machinery
 *  (stream resyncs, terminal RPCs, fire-and-forget persistence) took the
 *  whole server down on Node's default `--unhandled-rejections=throw`.
 *  The supervisor then needs ~30s to notice and restart, which drops every
 *  tab's SSE and, in spawn mode, every running turn.
 *
 *  Individual call sites still get their own `.catch()` — this is the net
 *  under them, not a replacement for them. Anything caught here is a bug:
 *  it is logged with a stack to `$STATE_DIR/server.log` so it can be found
 *  and fixed at the source rather than silently absorbed.
 *
 *  `register()` runs once per server instance, before the first request.
 */
export async function register() {
  // `nodejs` only — the edge runtime has no `process` lifecycle events, and
  // the handlers must be installed exactly once per process.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { install } = await import("./instrumentation.node");
  install();
}
