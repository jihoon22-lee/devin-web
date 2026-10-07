import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

test("search pages in an old node instead of jumping to a shared text prefix", async ({ page, request }, testInfo) => {
  // Reproduce a pagination scroll event arriving after the jump effect has
  // unpinned, but before its animation frame moves to the selected message.
  await page.addInitScript(() => {
    const frame = window.requestAnimationFrame;
    let dispatched = false;
    window.requestAnimationFrame = (callback) => frame((time) => {
      const target = document.getElementById("msg-bf-7");
      const scroller = target?.closest(".overflow-y-auto");
      if (!dispatched && scroller && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 3) {
        dispatched = true;
        scroller.dispatchEvent(new Event("scroll"));
        document.documentElement.dataset.jumpScrollRace = "dispatched";
      }
      callback(time);
    });
  });
  const sid = "e2e-session-searchjump";
  const loaded = await request.post(`/api/sessions/${sid}/load`, {
    data: { cwd: join(process.cwd(), ".e2e-fixture", "project") },
    headers: { "x-devin-web": "1" },
  });
  expect(loaded.ok()).toBeTruthy();
  await page.goto(`/?s=${sid}`);
  await expect(page.locator("#msg-bf-120")).toBeVisible();
  await expect(page.locator("#msg-bf-7")).toHaveCount(0);
  const older: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes(`/sessions/${sid}/transcript?`) && r.url().includes("before=")) older.push(r.url());
  });
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("Jump to session, or search message contents…").fill("ancientneedle");
  await page.locator(`#dw-pal-h-${sid}`).click();
  await expect(dialog).toHaveCount(0);
  const target = page.locator("#msg-bf-7");
  await expect(target).toContainText("ancientneedle");
  await expect(target).toHaveClass(/ring-2/);
  try {
    await expect(target).toBeInViewport();
  } catch (error) {
    const geometry = JSON.stringify(await target.evaluate((element) => {
      const ancestors = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const bounds = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        ancestors.push({ tag: node.tagName, id: node.id, className: node.className,
          top: bounds.top, bottom: bounds.bottom, height: bounds.height,
          scrollTop: node.scrollTop, scrollHeight: node.scrollHeight,
          overflowY: style.overflowY, contentVisibility: style.contentVisibility });
      }
      return { viewport: { width: innerWidth, height: innerHeight }, ancestors };
    }), null, 2);
    writeFileSync(testInfo.outputPath("jump-geometry.json"), geometry);
    await page.screenshot({ path: testInfo.outputPath("jump-screen.png") });
    throw error;
  }
  await expect(page.locator("html")).toHaveAttribute("data-jump-scroll-race", "dispatched");
  expect(older.length).toBeGreaterThan(0);
  expect(older.length).toBeLessThanOrEqual(20);
});
