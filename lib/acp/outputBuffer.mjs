// Bounded terminal output with absolute byte offsets — ONE implementation
// shared by the daemon host (host.mjs) and the in-process pool
// (terminal.ts). Trimming re-encodes the whole retained buffer, so it runs
// only once the buffer overshoots `limit` by `slack` and then cuts back to
// `limit`: amortized O(1) per chunk instead of O(limit) (a chatty build log
// used to copy 512KB per 4KB chunk inside the daemon — R12 B3).
// Changes here need `ctl acpd restart --when-idle` (host.mjs imports it).

/** @typedef {{ output: string, outputBytes: number, baseOffset: number, truncated: boolean }} OutputState */

/** @param {number} limit */
export const slackFor = (limit) => Math.max(64 * 1024, Math.floor(limit / 2));

/** Advance `cut` to the next UTF-8 sequence start — a mid-sequence slice
 *  decodes to U+FFFD and byte offsets drift from the real stream.
 *  @param {Buffer} b @param {number} cut */
export function utf8Boundary(b, cut) {
  while (cut < b.length && (b[cut] & 0xc0) === 0x80) cut++;
  return cut;
}

/** Cut the retained output down to at most `limit` bytes (tail kept).
 *  @param {OutputState} st @param {number} limit */
export function trimTo(st, limit) {
  if (st.outputBytes <= limit) return;
  const b = Buffer.from(st.output, "utf8");
  const cut = utf8Boundary(b, b.length - limit);
  st.baseOffset += cut;
  st.output = b.subarray(cut).toString("utf8");
  st.outputBytes = b.length - cut;
  st.truncated = true;
}

/** Append `data`; returns true when this call trimmed.
 *  @param {OutputState} st @param {string} data @param {number} limit */
export function appendOutput(st, data, limit) {
  st.output += data;
  st.outputBytes += Buffer.byteLength(data);
  if (st.outputBytes <= limit + slackFor(limit)) return false;
  trimTo(st, limit);
  return true;
}

/** The ACP `terminal/output` view — the protocol promises at most `limit`
 *  bytes, so the slack is cut off on read (rare), never on write.
 *  @param {OutputState} st @param {number} limit */
export function tailWithin(st, limit) {
  if (st.outputBytes <= limit) return st.output;
  const b = Buffer.from(st.output, "utf8");
  return b.subarray(utf8Boundary(b, b.length - limit)).toString("utf8");
}
