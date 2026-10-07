import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { join } from "node:path";

/** Side surfaces: seed fidelity, palette search, Files tab, Changes tab. */

const FIX = join(process.cwd(), ".e2e-fixture");
// this spec's own fixture session — never prompted, so the exact-count
// assertion below always sees just the 4 seeded nodes
const SID = "e2e-session-panels";
const CWD = join(FIX, "project");

async function openSession(page: Page, request: APIRequestContext, sid = SID, marker = "panels spec seed") {
  const res = await request.post(`/api/sessions/${sid}/load`, {
    data: { cwd: CWD },
    headers: { "x-devin-web": "1" },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto(`/?s=${sid}`);
  await expect(page.locator("main")).toContainText(marker, { timeout: 30_000 });
}

test("opening a session renders each fixture message exactly once", async ({ page, request }) => {
  test.setTimeout(120_000);
  await openSession(page, request);
  const items = page.locator("main .dw-virt");
  await expect(items).toHaveCount(4, { timeout: 15_000 });
  await expect(items.nth(0)).toContainText("panels spec seed one");
  await expect(items.nth(3)).toContainText("panels spec seed reply two");
});

test("command palette searches message contents and jumps to the hit", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  // wait for hydration before the keydown — the shortcut binds in an effect
  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByPlaceholder("Jump to session, or search message contents…").fill("Last-Event-ID");

  const hit = page.locator("#dw-pal-h-e2e-session-panels");
  await expect(hit).toBeVisible({ timeout: 20_000 });
  await expect(hit).toContainText("E2E panels session");
  await hit.click();

  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/s=e2e-session-panels/);
  await expect(page.locator("main")).toContainText("Last-Event-ID", { timeout: 30_000 });
});

test("Files tab lists the project tree and opens a file", async ({ page, request }) => {
  test.setTimeout(120_000);
  await openSession(page, request);
  await page.getByRole("tab", { name: "Files" }).click();

  // the root dir is always open and auto-lists — expand src, open the file
  await page.getByRole("button", { name: "src" }).click();
  await page.getByRole("button", { name: "main.ts", exact: true }).click();
  await expect(page.locator("main")).toContainText("fixtureMarker", { timeout: 15_000 });
});

test("Changes tab lists the dirty file, shows its diff, and stages it", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await openSession(page, request);
  await page.getByRole("tab", { name: "Changes" }).click();

  const row = page.locator("main").getByText("README.md");
  await expect(row.first()).toBeVisible({ timeout: 15_000 });
  await row.first().click(); // expand the inline diff
  await expect(page.locator("main")).toContainText("modified line for the diff view", {
    timeout: 15_000,
  });

  await page.getByTitle("Stage file").click();
  await expect(page.locator("main").getByText("staged")).toBeVisible({ timeout: 15_000 });
});
