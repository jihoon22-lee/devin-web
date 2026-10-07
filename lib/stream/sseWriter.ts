/** SSE byte writer with the slow-consumer cutoff. Bytes are counted since
 *  the consumer last drained; past `maxPending` the stream is ERRORED, not
 *  closed — close() still delivers every queued chunk first (8MB of stale
 *  frames down a slow mobile link before EventSource can even reconnect),
 *  while error() discards the queue at once (R12 B4). */
export function createSseWriter(
  controller: ReadableStreamDefaultController<Uint8Array>,
  opts: { maxPending: number; onCutoff: (pendingBytes: number) => void },
) {
  const encoder = new TextEncoder();
  let pending = 0;
  let dead = false;
  return {
    get dead() {
      return dead;
    },
    write(chunk: string): boolean {
      if (dead) return false;
      try {
        const b = encoder.encode(chunk);
        controller.enqueue(b);
        pending += b.length;
        if ((controller.desiredSize ?? 0) > 0) pending = 0;
        else if (pending > opts.maxPending) {
          dead = true;
          controller.error(new Error("slow consumer"));
          opts.onCutoff(pending);
          return false;
        }
        return true;
      } catch {
        dead = true; // controller already closed/errored
        return false;
      }
    },
    close() {
      if (dead) return;
      dead = true;
      try {
        controller.close();
      } catch {
        /* already closed/errored */
      }
    },
  };
}
