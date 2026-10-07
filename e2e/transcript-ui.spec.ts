import { expect, test } from "@playwright/test";

/** Read-only UI surfaces driven purely by the fixture: transcript paging,
 *  the locked-session view, and the mobile sidebar drawer. No agent traffic. */

test("Load earlier pages a long transcript back to the first message", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?s=e2e-session-long");

  const items = page.locator("main .dw-virt");
  const earlier = page.getByRole("button", { name: /Load earlier/ });
  // tail=50 seed: newest 50 of 120 nodes
  await expect(items).toHaveCount(50, { timeout: 30_000 });
  await expect(page.locator("main")).toContainText("message number 120");
  await expect(earlier).toBeVisible();

  await earlier.click();
  await expect(items).toHaveCount(100, { timeout: 15_000 });
  await expect(earlier).toBeVisible(); // 20 nodes still above the window

  await earlier.click();
  await expect(items).toHaveCount(120, { timeout: 15_000 });
  await expect(page.locator("main")).toContainText("message number 1 ");
  await expect(earlier).toHaveCount(0); // chain root reached — affordance goes away
});

test("a session locked by another devin process opens read-only with a Take over action", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await page.goto("/?s=e2e-session-locked");

  const main = page.locator("main");
  await expect(main).toContainText("read-only", { timeout: 30_000 });
  await expect(main).toContainText("open in another devin process");
  await expect(page.getByRole("button", { name: /Take over/ })).toBeVisible();
  // the locked view must not offer a composer
  await expect(page.locator("main textarea")).toHaveCount(0);

  // delete is refused while a live foreign process holds the session lock —
  // the API answers 409 and the sidebar's Delete entry stays disabled until
  // a takeover moves the lock to us
  const del = await request.delete("/api/sessions/e2e-session-locked", {
    headers: { "x-devin-web": "1" },
  });
  expect(del.status()).toBe(409);
  expect((await del.json()).error).toMatch(/take it over first/);

  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  const row = page.locator("aside").getByText("E2E locked session").first();
  // the drawer can scroll the selected row into view after opening, which
  // closes a FloatMenu anchored to it — retry the whole open+assert block
  await expect(async () => {
    if (!(await page.getByRole("menu").isVisible()))
      await row.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeDisabled({ timeout: 2_000 });
    await expect(page.getByRole("menuitem", { name: "Take over" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await page.keyboard.press("Escape");
});

test("mobile sidebar opens from the Menu button and closes on the scrim", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  // 390px viewport: sidebar starts hidden behind the hamburger
  const menu = page.getByRole("button", { name: "Open sidebar" });
  await expect(menu).toBeVisible({ timeout: 30_000 });
  // the sidebar renders the title twice (tooltip + row) — scope to the aside
  const sessionLink = page.locator("aside").getByText("E2E drawer session").first();
  await expect(sessionLink).toBeHidden();

  await menu.click();
  await expect(sessionLink).toBeVisible();

  // the dim scrim behind the drawer dismisses it
  await page.locator("div.fixed.inset-0.z-30").click({ position: { x: 340, y: 400 } });
  await expect(sessionLink).toBeHidden();
});
