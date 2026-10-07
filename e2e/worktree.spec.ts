import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixturePaths } from "./fixtures/environment.mjs";

const FIX = join(process.cwd(), ".e2e-fixture");
const PROJECT = join(FIX, "project");

test("new session can start in an isolated worktree", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  // type the fixture project path into the picker and navigate to it
  const input = page.locator("input.mono");
  // the picker mirrors each resolved listing back into the input — wait for
  // the initial ~ fetch to land or it stomps what we type
  await expect(input).toHaveValue(fixturePaths(process.cwd()).home);
  await input.fill(PROJECT);
  await input.press("Enter");
  // nav refetches the listing; the picker shows dirs only — wait for `src`
  await page.getByRole("button", { name: "src", exact: true }).waitFor();
  await page.getByText("Start in isolated worktree").click();
  await page.getByRole("button", { name: /Select/ }).click();
  // a worktree session: open the sidebar and the branch chip shows
  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.getByTitle(/Isolated worktree: devin-web\//)).toBeVisible({ timeout: 15_000 });
  const chip = await page.getByTitle(/Isolated worktree: devin-web\//).first().textContent();
  const slug = chip!.trim();
  expect(existsSync(join(FIX, "state", "worktrees", slug))).toBe(true);
});
