import net from "node:net";
import { expect, test } from "@playwright/test";

/** F3 smoke: sever the SSE transport, let the client reconnect, and the
 *  transcript it already had must still be on screen — not a blank pane
 *  waiting for a reseed.
 *
 *  `context.setOffline` can't do this: it blocks new requests but leaves the
 *  established EventSource socket alive (verified — no reconnect ever fires).
 *  So the page is pointed at a tiny in-test TCP proxy; destroying its live
 *  sockets kills the SSE for real while the proxy keeps accepting the retry.
 *
 *  Read-only: no prompts, no agent spawns. */

const UPSTREAM = 3200;
const PROXY = 3201;

test("SSE disconnect → reconnect preserves the rendered transcript", async ({
  page,
  request,
}) => {
  // this spec's own fixture session — never shared with other specs
  const SID = "e2e-session-reconnect";
  const { sessions } = (await request.get("/api/sessions").then((r) => r.json())) as {
    sessions: { sessionId: string }[];
  };
  // hermetic fixture (e2e/fixtures/make-fixture.mjs)
  expect(sessions.map((s) => s.sessionId)).toContain(SID);
  // cold `next start` + a heavy transcript make the seed path slow
  test.setTimeout(180_000);

  // in-test TCP proxy: page → PROXY → UPSTREAM. Destroying live sockets
  // severs the SSE; the listener stays up so the client's retry lands.
  const live = new Set<net.Socket>();
  const proxy = net.createServer((client) => {
    const upstream = net.connect(UPSTREAM, "127.0.0.1");
    live.add(client).add(upstream);
    const drop = (s: net.Socket) => () => live.delete(s);
    client.on("close", drop(client)).on("error", drop(client));
    upstream.on("close", drop(upstream)).on("error", drop(upstream));
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((res) => proxy.listen(PROXY, "127.0.0.1", res));

  let streamReqs = 0;
  const sessionSubscriptions = new Set<string>();
  page.on("request", (r) => {
    if (r.url().includes("/api/stream?")) streamReqs++;
    if (r.url().endsWith("/api/stream/subscribe") && r.method() === "POST") {
      const body = r.postDataJSON() as { add?: { kind: string; id: string }[] };
      for (const sub of body.add ?? []) {
        if (sub.id === SID) sessionSubscriptions.add(sub.kind);
      }
    }
  });

  try {
  await page.goto(`http://127.0.0.1:${PROXY}/?s=${encodeURIComponent(SID)}`);
  const main = page.locator("main");

  // wait for seeded transcript content, then take the marker straight from
  // the DOM — transcript-API tail items can land in collapsed <details>
  // blocks that innerText never exposes
  await page.waitForFunction(
    () =>
      document
        .querySelector("main")
        ?.innerText.split("\n")
        .some((l) => l.trim().length > 25),
    { timeout: 30_000 },
  );
  const marker = (await main.innerText())
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 25 && !/connecting|Load earlier|Take over/.test(l))
    .pop()!;
  expect(marker.length).toBeGreaterThan(25);
  expect(streamReqs).toBeGreaterThanOrEqual(1);
  // The browser must use the authoritative view path.
  await expect.poll(() => sessionSubscriptions.has("view")).toBe(true);
  expect(sessionSubscriptions.has("session")).toBe(false);

  // sever every proxied socket — the EventSource connection dies with them
  for (const s of [...live]) s.destroy();

  // the client must actually re-open the stream — not just sit on a dead one
  await expect
    .poll(() => streamReqs, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2);
  // and the pre-disconnect transcript must still be rendered
  await expect(main).toContainText(marker, { timeout: 20_000 });
  } finally {
    // proxy.close() waits on open connections — the reconnected SSE and
    // keep-alive sockets never end on their own, so destroy first
    for (const s of [...live]) s.destroy();
    await new Promise<void>((res) => proxy.close(() => res()));
  }
});

test("mobile session reload preserves its URL and view subscription", async ({ page }) => {
  const SID = "e2e-session-reconnect";
  const subscriptions = new Set<string>();
  page.on("request", (r) => {
    if (!r.url().endsWith("/api/stream/subscribe") || r.method() !== "POST") return;
    const body = r.postDataJSON() as { add?: { kind: string; id: string }[] };
    for (const sub of body.add ?? []) {
      if (sub.id === SID) subscriptions.add(sub.kind);
    }
  });

  await page.goto(`/?s=${encodeURIComponent(SID)}`);
  await expect(page.locator("main")).toContainText("Please summarize how the stream mux handles a reconnect.");
  await expect.poll(() => subscriptions.has("view")).toBe(true);
  expect(subscriptions.has("session")).toBe(false);
  await page.getByTitle("Sessions").click();
  await expect(page.locator("aside")).toBeVisible();
  subscriptions.clear();
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`\\?s=${SID}$`));
  await expect.poll(() => subscriptions.has("view")).toBe(true);
  expect(subscriptions.has("session")).toBe(false);
  await expect(page.locator("main")).toContainText("Please summarize how the stream mux handles a reconnect.");
});
