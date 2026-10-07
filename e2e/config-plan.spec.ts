import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Plan-surface spec — the dock/panel/cards driven by a scripted live plan —
 *  plus the config bar driven by the fake agent's configOptions (see
 *  DEFAULT_CONFIG in test/fixtures/fake-acp.mjs). See live-turn.spec.ts for
 *  the fixture/script conventions. */

const FIX = join(process.cwd(), ".e2e-fixture");
const SCRIPT = join(FIX, "turn-script.json");
// every spec owns exactly one fixture session (see make-fixture.mjs)
const SID = "e2e-session-config-plan";
const CWD = join(FIX, "project");

const writeScript = (turns: unknown[]) =>
  writeFileSync(SCRIPT, JSON.stringify({ turns }));

async function openSession(page: Page, request: APIRequestContext) {
  // pin the dock expanded before app code reads localStorage
  await page.addInitScript(
    (sid) => window.localStorage.setItem(`dw-plan-dock:${sid}`, "1"),
    SID,
  );
  const res = await request.post(`/api/sessions/${SID}/load`, {
    data: { cwd: CWD },
    headers: { "x-devin-web": "1" },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto(`/?s=${SID}`);
  await expect(page.locator("main"), "fixture transcript should seed").toContainText(
    "config-plan spec seed",
    { timeout: 30_000 },
  );
}

async function send(page: Page, text: string) {
  await page.locator("textarea").fill(text);
  await page.getByRole("button", { name: /^(Send|Queue message)$/ }).click();
}

test.beforeEach(() => rmSync(SCRIPT, { force: true }));
test.afterEach(() => rmSync(SCRIPT, { force: true }));

test("plan dock tracks the live plan and keeps its snapshot history", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  writeScript([
    {
      match: "config-plan-probe",
      steps: [
        {
          delayMs: 60,
          emit: {
            sessionUpdate: "plan",
            entries: [
              { content: "alpha step", status: "in_progress" },
              { content: "beta step", status: "pending" },
            ],
          },
        },
        {
          delayMs: 150,
          emit: {
            sessionUpdate: "plan",
            entries: [
              { content: "alpha step", status: "completed" },
              { content: "beta step", status: "pending" },
            ],
          },
        },
        {
          delayMs: 60,
          emit: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "config-plan reply done" },
          },
        },
        // hold the turn open — the revision trail is provisional-only, so
        // the two-snapshot history is asserted mid-turn
        { delayMs: 20_000 },
      ],
    },
  ]);
  await openSession(page, request);
  await send(page, "config-plan-probe: track my plan");

  // dock bar: "Plan 1/2" once the second emit lands
  const dock = page.locator("[data-plan-dock]");
  await expect(dock).toContainText("Plan 1/2", { timeout: 20_000 });
  await expect(page.locator("main")).toContainText("config-plan reply done", {
    timeout: 20_000,
  });

  // expanded dock (pinned via addInitScript) shows the current checklist
  await expect(dock).toContainText("alpha step");
  await expect(dock).toContainText("beta step");

  // both plan emits survived as snapshots in the dock's history tab
  await dock.getByRole("button", { name: /History \(2\)/ }).click();
  await expect(dock.locator(".dw-plan-row")).toHaveCount(2);

  // end the turn — the retained plan card keeps the dock pinned (beta is
  // still pending), collapsed back to the latest snapshot
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator("role=status")).toHaveCount(0, { timeout: 20_000 });
  await expect(dock).toContainText("Plan 1/2", { timeout: 20_000 });
});

test("config bar renders the session configOptions and applies a model switch", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await openSession(page, request);

  // chips come from the session/load result's configOptions (fake-acp
  // DEFAULT_CONFIG: mode=code, model=fake-alpha, thought=low/medium/high).
  // Every viewport shows them as separate controls in one row — the mode
  // chip, the model chip, and the inline Thinking segment.
  const modeChip = page.getByRole("button", { name: "Code", exact: true });
  const modelChip = page.getByRole("button", { name: /Fake Alpha/ });
  await expect(modeChip).toBeVisible({ timeout: 15_000 });
  await expect(modelChip).toBeVisible();

  const thought = page.getByRole("group", { name: "Thinking" });
  await expect(thought.getByRole("button")).toHaveCount(3);
  await expect(thought.getByRole("button", { name: "High" })).toBeVisible();

  // mode chip → popover menu
  await modeChip.click();
  await expect(
    page.getByRole("menu", { name: "Mode" }).getByRole("menuitem", { name: "Code", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // model chip → popover listbox → pick Fake Beta
  await modelChip.click();
  await page
    .getByRole("listbox", { name: "Model" })
    .getByRole("option", { name: /Fake Beta/ })
    .click();
  await expect(page.getByRole("button", { name: /Fake Beta/ })).toBeVisible();

  // the echoed set_config_option result narrows thought_level to low/medium —
  // only the server's config_option_update can remove "High"
  await expect(thought.getByRole("button")).toHaveCount(2, { timeout: 15_000 });
  await expect(thought.getByRole("button", { name: "Low" })).toBeVisible();
  await expect(thought.getByRole("button", { name: "Medium" })).toBeVisible();
});
