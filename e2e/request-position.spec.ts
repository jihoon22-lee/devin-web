import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Permission/elicitation cards are turn content — they must render at the
 *  position the agent asked (after the triggering tool call, before later
 *  output), not piled at the tail. Owns e2e-session-reqpos. */

const FIX = join(process.cwd(), ".e2e-fixture");
const SCRIPT = join(FIX, "turn-script.json");
const SID = "e2e-session-reqpos";
const CWD = join(FIX, "project");

const writeScript = (turns: unknown[]) =>
  writeFileSync(SCRIPT, JSON.stringify({ turns }));

async function openSession(page: Page, request: APIRequestContext) {
  const res = await request.post(`/api/sessions/${SID}/load`, {
    data: { cwd: CWD },
    headers: { "x-devin-web": "1" },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto(`/?s=${SID}`);
  await expect(page.locator("main")).toContainText("reqpos spec seed", { timeout: 30_000 });
}

test.beforeEach(() => rmSync(SCRIPT, { force: true }));
test.afterEach(() => rmSync(SCRIPT, { force: true }));

test("a permission card renders between the tool call and the next output", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  writeScript([
    {
      match: "position check",
      steps: [
        { emit: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Ran dangerous-command", status: "in_progress" } },
        {
          request: {
            method: "session/request_permission",
            params: {
              toolCall: { toolCallId: "t1", title: "Ran dangerous-command" },
              options: [
                { optionId: "allow", name: "Allow once", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ],
            },
          },
        },
        { emit: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } },
        { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after the answer" } } },
      ],
    },
  ]);
  await openSession(page, request);
  await page.locator("textarea").fill("position check please");
  await page.getByRole("button", { name: /^(Send|Queue message)$/ }).click();

  // the card appears mid-stream, right after its tool call
  const card = page.locator("[data-perm-pending]");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "Allow once" }).click();

  // after the answer the turn continues — the card stays where it was asked
  await expect(page.locator("main")).toContainText("after the answer");
  const items = await page.locator("main [id^=msg-]").evaluateAll((els) =>
    els.map((e) => ({ id: e.id.replace(/^msg-/, ""), text: e.textContent ?? "" })),
  );
  const reqIdx = items.findIndex((i) => i.id.startsWith("req-"));
  const toolIdx = items.findIndex((i) => i.text.includes("Ran dangerous-command"));
  const afterIdx = items.findIndex((i) => i.text.includes("after the answer"));
  expect(reqIdx).toBeGreaterThan(-1);
  expect(toolIdx).toBeGreaterThan(-1);
  expect(afterIdx).toBeGreaterThan(-1);
  // the CLI order: tool call → permission ask → following output
  expect(reqIdx).toBeGreaterThan(toolIdx);
  expect(reqIdx).toBeLessThan(afterIdx);
});
