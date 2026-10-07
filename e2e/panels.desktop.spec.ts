import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { join } from "node:path";

/** Desktop (≥md) layout coverage the phone project can't see: the side
 *  panel docks right of the chat with a left-edge resize handle, tabs
 *  toggle it closed, and config stays as separate chips. */

const FIX = join(process.cwd(), ".e2e-fixture");
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

test("the side panel docks right of the chat column", async ({ page, request }) => {
  test.setTimeout(120_000);
  await openSession(page, request);
  await page.getByRole("tab", { name: "Files" }).click();

  const sep = page.getByRole("separator", { name: "Resize panel" });
  await expect(sep).toBeVisible();
  const box = (await sep.boundingBox())!;
  // right-docked: the handle sits past the viewport centre, and the chat
  // transcript stays rendered to its left
  expect(box.x).toBeGreaterThan(600);
  await expect(page.locator("main .dw-virt")).toHaveCount(4);
});

test("ArrowLeft on the panel's left-edge handle widens it", async ({ page, request }) => {
  test.setTimeout(120_000);
  await openSession(page, request);
  await page.getByRole("tab", { name: "Changes" }).click();

  const sep = page.getByRole("separator", { name: "Resize panel" });
  await sep.focus();
  const before = Number(await sep.getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowLeft");
  await expect(sep).toHaveAttribute("aria-valuenow", String(before + 16));
  await page.keyboard.press("ArrowRight");
  await expect(sep).toHaveAttribute("aria-valuenow", String(before));
});

test("clicking the active tab closes the panel", async ({ page, request }) => {
  test.setTimeout(120_000);
  await openSession(page, request);
  const files = page.getByRole("tab", { name: "Files" });
  await files.click();
  await expect(page.getByRole("separator", { name: "Resize panel" })).toBeVisible();
  await files.click();
  await expect(page.getByRole("separator", { name: "Resize panel" })).toHaveCount(0);
});

test("the Chat tab only exists below md", async ({ page, request }) => {
  test.setTimeout(120_000);
  await openSession(page, request);
  await expect(page.getByRole("tab", { name: "Chat" })).toBeHidden();
});

test("config controls render as separate chips", async ({ page, request }) => {
  test.setTimeout(120_000);
  await openSession(page, request);
  await expect(page.getByRole("button", { name: "Code", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Fake Alpha/ })).toBeVisible();
  await expect(page.getByRole("group", { name: "Thinking" }).getByRole("button")).toHaveCount(3);
});
