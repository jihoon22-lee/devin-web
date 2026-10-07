import { attachStream, detachStream, type WireMsg } from "@/lib/stream/connections";
import { serverEpoch } from "@/lib/stream/epoch";
import { createSseWriter } from "@/lib/stream/sseWriter";

export const dynamic = "force-dynamic";

/** GET /api/stream?c=<connId>[&last=<n>][&v=0|1] — the tab's single multiplexed SSE
 *  connection. Subscriptions are managed via POST /api/stream/subscribe.
 *  The cursor comes from Last-Event-ID (browser auto-reconnect) or `last`
 *  (a freshly created EventSource, which never sends the header). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const connId = url.searchParams.get("c");
  if (!connId || connId.length > 128) {
    return new Response("missing/invalid c", { status: 400 });
  }
  const lastSeen =
    Number(req.headers.get("last-event-id") ?? url.searchParams.get("last") ?? 0) || 0;
  // v=0: the tab connected while hidden (push notifications still apply)
  const visible = url.searchParams.get("v") !== "0";

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const tag = `${connId}#${Math.random().toString(36).slice(2, 8)}`;
      // slow consumers are cut at 8MB pending — see lib/stream/sseWriter.ts
      const w = createSseWriter(controller, {
        maxPending: 8 * 1024 * 1024,
        onCutoff: (bytes) => {
          console.log(`[stream] ${new Date().toISOString()} ${tag} slow-consumer cutoff at ${(bytes / 1048576).toFixed(1)}MB pending`);
          // abort can lag — release the subs now so producers stop early
          detachStream(connId, send);
        },
      });
      const send = (msg: WireMsg): boolean => w.write(`id: ${msg.n}\ndata: ${JSON.stringify(msg)}\n\n`);
      attachStream(connId, lastSeen, send, visible);
      // no `id:` line — an id would overwrite the browser's Last-Event-ID
      w.write(`data: ${JSON.stringify({ kind: "meta", type: "ready", epoch: serverEpoch() })}\n\n`);
      const ping = setInterval(() => {
        if (!w.write(`: ping\n\n`)) clearInterval(ping);
      }, 15000);
      console.log(`[stream] ${new Date().toISOString()} ${tag} connected (last=${lastSeen})`);
      req.signal.addEventListener("abort", () => {
        clearInterval(ping);
        console.log(`[stream] ${new Date().toISOString()} ${tag} disconnected`);
        detachStream(connId, send);
        w.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
