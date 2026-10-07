import net from "node:net";
import { expect, test } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Sever the transport mid-turn: events emitted while the client is down are
 *  buffered in the server ring and must replay in order after reconnect —
 *  no gaps, no duplicates. Same in-test TCP proxy as reconnect.spec.ts. */

const UPSTREAM = 3200;
const PROXY = 3202;
const FIX = join(process.cwd(), ".e2e-fixture");
const SCRIPT = join(FIX, "turn-script.json");
const SID = "e2e-session-turnrc"; // this spec's own fixture session — never shared

test.afterEach(() => rmSync(SCRIPT, { force: true }));

test("mid-turn SSE sever buffers events and replays them in order", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  writeFileSync(
    SCRIPT,
    JSON.stringify({
      turns: [
        {
          match: "midturn-probe",
          steps: [
            { delayMs: 150, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "e2e-midturn-A " } } },
            { delayMs: 500, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "e2e-midturn-B " } } },
            { delayMs: 500, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "e2e-midturn-C" } } },
          ],
        },
      ],
    }),
  );

  const res = await request.post(`/api/sessions/${SID}/load`, {
    data: { cwd: join(FIX, "project") },
    headers: { "x-devin-web": "1" },
  });
  expect(res.ok()).toBeTruthy();

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
  page.on("request", (r) => {
    if (r.url().includes("/api/stream?")) streamReqs++;
  });

  try {
    await page.goto(`http://127.0.0.1:${PROXY}/?s=${SID}`);
    const main = page.locator("main");
    await expect(main).toContainText("turn-reconnect spec seed", { timeout: 30_000 });

    await page.locator("textarea").fill("midturn-probe survives a cut");
    await page.getByRole("button", { name: "Send" }).click();
    // the echo must be on screen — the prompt POST made it through the proxy
    await expect(main.locator("div.self-end", { hasText: "midturn-probe" })).toHaveCount(1, {
      timeout: 15_000,
    });

    // kill the transport while chunks are still in flight
    for (const s of [...live]) s.destroy();
    await expect
      .poll(() => streamReqs, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);

    // every chunk lands exactly once, in order, after reconnect
    await expect(main.locator(".dw-virt", { hasText: "e2e-midturn-A" })).toHaveCount(1, {
      timeout: 20_000,
    });
    await expect(main).toContainText("e2e-midturn-A e2e-midturn-B e2e-midturn-C", {
      timeout: 20_000,
    });
    await expect(page.locator("role=status")).toHaveCount(0, { timeout: 20_000 });
  } finally {
    for (const s of [...live]) s.destroy();
    await new Promise<void>((res) => proxy.close(() => res()));
  }
});
