import { expect, test } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Two tabs on one session: the server must fan events out to both and badge
 *  the viewer count. Uses the same scripted-turn hook as live-turn.spec. */

const FIX = join(process.cwd(), ".e2e-fixture");
const SCRIPT = join(FIX, "turn-script.json");
const SID = "e2e-session-mirror"; // this spec's own fixture session — never shared

test.afterEach(() => rmSync(SCRIPT, { force: true }));

test("two viewers see the watchers badge and the same live events", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(120_000);
  const res = await request.post(`/api/sessions/${SID}/load`, {
    data: { cwd: join(FIX, "project") },
    headers: { "x-devin-web": "1" },
  });
  expect(res.ok()).toBeTruthy();

  await page.goto(`/?s=${SID}`);
  await expect(page.locator("main")).toContainText("multi-client spec seed", {
    timeout: 30_000,
  });
  const page2 = await context.newPage();
  await page2.goto(`/?s=${SID}`);
  await expect(page2.locator("main")).toContainText("multi-client spec seed", {
    timeout: 30_000,
  });

  // the seq-0 watchers push: both tabs should settle on 👁2
  await expect(page.getByTitle("2 clients viewing this session")).toBeVisible({ timeout: 15_000 });
  await expect(page2.getByTitle("2 clients viewing this session")).toBeVisible({ timeout: 15_000 });

  writeFileSync(
    SCRIPT,
    JSON.stringify({
      turns: [
        {
          match: "fanout-probe",
          steps: [
            { delayMs: 80, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "e2e-fanout reply for both viewers" } } },
          ],
        },
      ],
    }),
  );
  await page.locator("textarea").fill("fanout-probe from tab one");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator("main")).toContainText("e2e-fanout reply for both viewers", {
    timeout: 20_000,
  });
  await expect(page2.locator("main")).toContainText("e2e-fanout reply for both viewers", {
    timeout: 20_000,
  });
  await expect(page2.locator("main div.self-end", { hasText: "fanout-probe" })).toHaveCount(1);
  await page2.close();
});
