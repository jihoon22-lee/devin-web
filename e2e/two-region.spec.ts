import net from "node:net";
import { expect, test } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Two-region transcript (P1-5/P2): run a scripted turn — sever the
 *  transport mid-stream — reconnect, and assert no sentence renders
 *  twice. The transcript is always durable ++ provisional now; the
 *  flag is gone (P2-1). */

const UPSTREAM = 3200;
const PROXY = 3203;
const FIX = join(process.cwd(), ".e2e-fixture");
const SCRIPT = join(FIX, "turn-script.json");
const SID = "e2e-session-tworegion"; // this spec's own fixture session

test.afterEach(() => rmSync(SCRIPT, { force: true }));

test("mid-turn sever+reconnect never duplicates", async ({ page, request }) => {
  test.setTimeout(180_000);
  writeFileSync(
    SCRIPT,
    JSON.stringify({
      turns: [
        {
          match: "tworegion-probe",
          steps: [
            { delayMs: 150, emit: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "tworegion-thought-one " } } },
            { delayMs: 300, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tworegion-answer-A " } } },
            { delayMs: 600, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tworegion-answer-B " } } },
            { delayMs: 600, emit: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "tworegion-thought-two " } } },
            { delayMs: 600, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tworegion-answer-C" } } },
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
    await expect(main).toContainText("two-region spec seed", { timeout: 30_000 });

    await page.locator("textarea").fill("tworegion-probe survives a cut");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(main.locator("div.self-end", { hasText: "tworegion-probe" })).toHaveCount(1, {
      timeout: 15_000,
    });

    // sever while the turn is mid-stream (A arrived, B/C still coming)
    await expect(main).toContainText("tworegion-answer-A", { timeout: 15_000 });
    for (const s of [...live]) s.destroy();
    await expect
      .poll(() => streamReqs, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);

    // every chunk lands exactly once after reconnect — the whole text of
    // the transcript is checked, so a duplicated ITEM also trips this.
    // (thought bodies render collapsed — count the thinking… ITEMS and
    // their DOM position instead of matching their hidden text)
    await expect(main).toContainText("tworegion-answer-C", { timeout: 30_000 });
    const probe = await page.evaluate(() => {
      const body = document.querySelector("main")?.innerText ?? "";
      const count = (s: string) => body.split(s).length - 1;
      const msgs = [...document.querySelectorAll('[id^="msg-"]')].map((m) => ({
        id: m.id,
        thought: /thinking|thought/.test(m.querySelector("button")?.textContent ?? ""),
        text: (m as HTMLElement).innerText?.replace(/\s+/g, " ") ?? "",
      }));
      return {
        a: count("tworegion-answer-A"),
        b: count("tworegion-answer-B"),
        c: count("tworegion-answer-C"),
        prompt: count("tworegion-probe survives a cut"),
        thoughts: msgs.filter((m) => m.thought).length,
        // chronology: thought-two streamed between answers B and C, so the
        // second thinking item must sit before the item carrying C — and
        // C must not be merged into the A·B item (interleaving preserved)
        secondThoughtIdx: msgs.findIndex((m, i) => m.thought && i > msgs.findIndex((x) => x.thought)),
        cItemIdx: msgs.findIndex((m) => m.text.includes("tworegion-answer-C")),
        cMerged: msgs.some((m) => m.text.includes("tworegion-answer-A") && m.text.includes("tworegion-answer-C")),
      };
    });
    expect(probe.a).toBe(1);
    expect(probe.b).toBe(1);
    expect(probe.c).toBe(1);
    expect(probe.prompt).toBe(1);
    expect(probe.thoughts).toBe(2);
    expect(probe.cMerged).toBe(false);
    expect(probe.secondThoughtIdx).toBeGreaterThanOrEqual(0);
    expect(probe.secondThoughtIdx).toBeLessThan(probe.cItemIdx);
    await expect(page.locator("role=status")).toHaveCount(0, { timeout: 20_000 });
  } finally {
    for (const s of [...live]) s.destroy();
    await new Promise<void>((res) => proxy.close(() => res()));
  }
});
