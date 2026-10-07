import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Send-now (queue steering) against the fake agent's scripted turns —
 *  see test/fixtures/fake-acp.mjs. A second session/prompt while a turn runs
 *  is accepted and answered mid-turn, like the real CLI's steer. */

const FIX = join(process.cwd(), ".e2e-fixture");
const SCRIPT = join(FIX, "turn-script.json");
// every spec owns exactly one fixture session — the server's per-session
// ring replays live events into later viewers, so ids must never be shared
const SID = "e2e-session-sendnow";
const CWD = join(FIX, "project");

const writeScript = (turns: unknown[]) =>
  writeFileSync(SCRIPT, JSON.stringify({ turns }));

async function openSession(page: Page, request: APIRequestContext) {
  const res = await request.post(`/api/sessions/${SID}/load`, {
    data: { cwd: CWD },
    headers: { "x-devin-web": "1" },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto(`/?s=${SID}`);
  await expect(
    page.locator("main"),
    "fixture transcript should seed",
  ).toContainText("send-now spec seed", { timeout: 30_000 });
}

async function send(page: Page, text: string) {
  await page.locator("textarea").fill(text);
  // busy state renames the button to "Queue message" — same control
  await page.getByRole("button", { name: /^(Send|Queue message)$/ }).click();
}

test.beforeEach(() => rmSync(SCRIPT, { force: true }));
test.afterEach(() => rmSync(SCRIPT, { force: true }));

test("send-now injects a queued prompt into the running turn", async ({ page, request }) => {
  test.setTimeout(120_000);
  writeScript([
    {
      match: "sendnow-first",
      steps: [
        { delayMs: 60, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "e2e-sendnow first reply" } } },
        { delayMs: 800 }, // stay busy while the steer lands
      ],
    },
    {
      match: "sendnow-steer",
      steps: [
        { delayMs: 60, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "e2e-sendnow steer reply" } } },
      ],
    },
  ]);
  await openSession(page, request);
  await send(page, "sendnow-first probe");
  const status = page.locator("role=status");
  await expect(status).toContainText("Working", { timeout: 10_000 });

  // the second prompt parks in the queue while turn 1 is on the clock
  await send(page, "sendnow-steer probe");
  await expect(status).toContainText("+1 queued", { timeout: 10_000 });

  await status.getByRole("button", { name: "+1 queued" }).click();
  await page.getByRole("button", { name: "send now" }).click();

  // the steer answer lands while turn 1 still runs — the message swapped its
  // queue ghost for one real bubble and the queue is empty
  await expect(page.locator("main")).toContainText("e2e-sendnow steer reply", { timeout: 20_000 });
  await expect(
    page.locator("main div.self-end", { hasText: "sendnow-steer probe" }),
  ).toHaveCount(1);
  await expect(status).not.toContainText("queued");

  // turn 1 then ends on its own schedule — no stuck "Working" state
  await expect(page.locator("main")).toContainText("e2e-sendnow first reply", { timeout: 20_000 });
  await expect(status).toHaveCount(0, { timeout: 20_000 });
});
