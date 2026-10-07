import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { join } from "node:path";

/** Work-history timeline + arbitrary-point fork. The e2e-session-tree
 *  fixture is a small forest: nodes 1→2 are the orphaned pre-compaction
 *  tree, 10→…→13 the main chain (root 10, parent NULL — compaction writes
 *  a fresh tree), and 14 a fork child of 11. The panel shows three
 *  segments: current (10–13), the orphaned segment (1–2), and the
 *  alternate branch (14). Revert steps come from FAKE_ACP_STEPS_FILE
 *  (steps.json): anchors at 11 and 13, so clicking node 10 forks at
 *  targetNodeId 11. */

const FIX = join(process.cwd(), ".e2e-fixture");
const SID = "e2e-session-tree";
const CWD = join(FIX, "project");

async function openSession(page: Page, request: APIRequestContext) {
  const res = await request.post(`/api/sessions/${SID}/load`, {
    data: { cwd: CWD },
    headers: { "x-devin-web": "1" },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto(`/?s=${SID}`);
  await expect(page.locator("main")).toContainText("tree spec — main-line answer", {
    timeout: 30_000,
  });
}

test("history panel lists segments with the current one flagged", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await openSession(page, request);
  await page.getByRole("tab", { name: "History", exact: true }).click();

  const main = page.locator("main");
  // all three segments surface — current, orphaned, alternate branch
  await expect(main).toContainText("post-compression first question", { timeout: 15_000 });
  await expect(main).toContainText("ORIGINAL pre-compaction question", { timeout: 15_000 });
  await expect(main).toContainText("ALTERNATE branch question");
  await expect(main).toContainText("current");
});

test("opening a segment shows just its span and returns to live", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await openSession(page, request);
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: /ORIGINAL pre-compaction question/ }).click();

  // overlay: the orphaned segment alone (seg=2&base=0), labelled read-only —
  // scope to the overlay: the live transcript stays mounted underneath it
  const overlay = page.getByTestId("branch-view");
  await expect(overlay).toContainText("earlier history", {
    timeout: 15_000,
  });
  await expect(overlay).toContainText("ORIGINAL pre-compaction question");
  await expect(overlay).toContainText("original answer before compression");
  // the segment read is bounded — main-chain content stays out
  await expect(overlay).not.toContainText("post-compression first answer");

  await page.getByRole("button", { name: "Back to live" }).click();
  await expect(page.locator("main")).not.toContainText("earlier history");
  await expect(page.locator("main")).toContainText("tree spec — main-line answer");
});

test("opening a branch segment shows it with its context", async ({ page, request }) => {
  test.setTimeout(120_000);
  await openSession(page, request);
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: /ALTERNATE branch question/ }).click();

  const overlay = page.getByTestId("branch-view");
  await expect(overlay).toContainText("earlier history", {
    timeout: 15_000,
  });
  await expect(overlay).toContainText("ALTERNATE branch question");
  // branch= resolves the subtree tip with its ancestry — context included
  await expect(overlay).toContainText("post-compression first answer");
});

test("fork from a message node creates and opens the forked session", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await openSession(page, request);

  // node 10 is covered by step s1 whose fork anchor is 11 →
  // fake-acp answers forkedSessionId s-fake-forked-11
  const item = page.locator("#msg-bf-10");
  await item.hover();
  await item.getByRole("button", { name: "Fork from this message" }).click();
  // in-app ConfirmDialog (no native dialog) — approve the fork
  await page.getByRole("dialog").getByRole("button", { name: "Fork" }).click();

  await page.waitForURL(/s=s-fake-forked-11/, { timeout: 15_000 });
  await expect(page.locator("main")).toContainText(/s-fake-forked-11|Forked at node 11/, {
    timeout: 30_000,
  });
});
