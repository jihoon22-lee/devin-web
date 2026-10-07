import { expect, test } from "@playwright/test";

// Owns e2e-session-archive — never open another spec's session.
test("archive hides a session in a collapsed section; unarchive restores it", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  // 390px viewport: sidebar starts hidden behind the hamburger
  await page.getByRole("button", { name: "Open sidebar" }).click();
  const sidebar = page.locator("aside");
  const row = sidebar.locator("div.group", { hasText: "E2E archive session" });
  await expect(row).toBeVisible({ timeout: 30_000 });

  // archive via the row's Session actions menu — leaves the group list
  await row.getByTitle("Session actions").click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(row).toBeHidden();
  await expect(sidebar.getByText("Archived")).toBeVisible();

  // expanding the section shows the parked session
  await sidebar.getByText("Archived").click();
  await expect(row).toBeVisible();
  await row.getByTitle("Session actions").click();
  await page.getByRole("menuitem", { name: "Unarchive" }).click();

  // restored to the normal group list — and the section is gone
  await expect(row).toBeVisible();
  await expect(sidebar.getByText("Archived")).toBeHidden();
});
