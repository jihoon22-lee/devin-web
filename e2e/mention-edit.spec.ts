import { expect, test } from "@playwright/test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FIX = join(process.cwd(), ".e2e-fixture");
const SID = "e2e-session-mentions";
const CWD = join(FIX, "project");
const SCRIPT = join(FIX, "turn-script.json");

test("queued mention editing preserves spaces, hash and literal percent escapes", async ({ page, request }) => {
  const file = join(CWD, "100%20 a #1.txt");
  writeFileSync(file, "mention fixture");
  writeFileSync(SCRIPT, JSON.stringify({ turns: [{ match: "hold-for-mention-edit", steps: [
    { delayMs: 60000, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "held" } } },
  ] }] }));
  const headers = { "x-devin-web": "1" };
  try {
    expect((await request.post(`/api/sessions/${SID}/load`, { headers, data: { cwd: CWD } })).ok()).toBeTruthy();
    await page.goto(`/?s=${SID}`);
    await expect(page.locator("main")).toContainText("mention spec reply");
    await request.post(`/api/sessions/${SID}/prompt`, { headers, data: { text: "hold-for-mention-edit" } });
    await expect(page.getByRole("button", { name: "Queue message", exact: true })).toBeVisible();
    await page.evaluate(({ sid, path }) => window.dispatchEvent(new CustomEvent("dw-mention", {
      detail: { sessionId: sid, path },
    })), { sid: SID, path: file });
    const input = page.locator("textarea");
    await expect(input).toHaveValue("@100%20 a #1.txt ");
    await page.getByRole("button", { name: "Queue message", exact: true }).click();
    await page.getByRole("button", { name: "+1 queued", exact: true }).click();
    const queue = () => JSON.parse(readFileSync(join(FIX, "state", "prompt-queue.json"), "utf8"))[SID][0];
    expect(queue().blocks.find((b: { type: string }) => b.type === "resource_link").uri).toBe(pathToFileURL(file).href);
    await page.getByRole("button", { name: "edit", exact: true }).click();
    await expect(input).toHaveValue("@100%20 a #1.txt ");
    await page.getByRole("button", { name: "Queue message", exact: true }).click();
    await expect(page.getByRole("button", { name: "+1 queued", exact: true })).toBeVisible();
    expect(queue().blocks.find((b: { type: string }) => b.type === "resource_link").uri).toBe(pathToFileURL(file).href);
    expect((await request.post(`/api/sessions/${SID}/cancel`, { headers, data: {} })).ok()).toBeTruthy();
    const sentMention = page.locator(".dw-virt span[title]").filter({ hasText: "@100%20 a #1.txt" });
    await expect(sentMention).toHaveAttribute("title", file);
  } finally {
    await request.post(`/api/sessions/${SID}/cancel`, { headers, data: { clearQueue: true } });
    rmSync(SCRIPT, { force: true });
    rmSync(file, { force: true });
  }
});
