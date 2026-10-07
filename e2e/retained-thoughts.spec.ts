import { expect, test, type Page } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Retained ephemera: thinking/plan must stay at their original transcript
 *  positions after the turn flips to durable — never dropped, never
 *  clumped at the tail. The script's `commit` steps make the fake CLI
 *  write the turn's durable rows (like the real CLI) so the flip runs. */

const FIX = join(process.cwd(), ".e2e-fixture");
const SCRIPT = join(FIX, "turn-script.json");
const SID = "e2e-session-retained";

test.afterEach(() => rmSync(SCRIPT, { force: true }));

/** Order of rendered transcript items, classified by marker text. */
const probeOrder = (page: Page) =>
  page.evaluate(() => {
    const msgs = [...document.querySelectorAll('[id^="msg-"]')].map((m) => {
      const el = m as HTMLElement;
      const t = el.innerText?.replace(/\s+/g, " ") ?? "";
      return {
        id: m.id,
        kind: /thinking|thought/.test(m.querySelector("button")?.textContent ?? "")
          ? "thought"
          : t.includes("retained-plan-step")
            ? "plan"
            : t.includes("retained-probe")
              ? "prompt"
              : t.includes("retained-answer-A")
                ? "answerA"
                : t.includes("retained-answer-B")
                  ? "answerB"
                  : "other",
      };
    });
    return msgs.map((m) => `${m.kind}:${m.id}`);
  });

test("thoughts and plan stay anchored after the turn flips to durable", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  writeFileSync(
    SCRIPT,
    JSON.stringify({
      turns: [
        {
          match: "retained-probe",
          steps: [
            { delayMs: 100, emit: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "retained-thought-one " } } },
            { delayMs: 150, emit: { sessionUpdate: "plan", entries: [{ content: "retained-plan-step", status: "in_progress" }] } },
            { delayMs: 200, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "retained-answer-A " } } },
            { delayMs: 200, emit: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "retained-thought-two " } } },
            { delayMs: 200, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "retained-answer-B" } } },
            // the CLI's durable commit for the turn — triggers the flip
            { commit: { role: "user", text: "$PROMPT" } },
            { commit: { role: "assistant", text: "retained-answer-A " } },
            { commit: { role: "assistant", text: "retained-answer-B" } },
          ],
        },
      ],
    }),
  );

  const res = await request.post(`/api/sessions/${SID}/load`, {
    data: { cwd: join(FIX, "project") },
    headers: { "x-devin-web": "1" },
  });
  expect(res.ok()).toBeTruthy();

  await page.goto(`/?s=${SID}`);
  const main = page.locator("main");
  await expect(main).toContainText("retained spec seed", { timeout: 30_000 });

  await page.locator("textarea").fill("retained-probe keeps my place");
  await page.getByRole("button", { name: "Send" }).click();

  // the turn streams, ends, and its durable commits flip the region —
  // thoughts/plan must still be there, at their ORIGINAL positions:
  // [prompt, thought1, plan, answerA, thought2, answerB].
  // The msg- ids prove the flip ran: prompt/answers render from durable
  // rows (bf-*) while the thoughts/plan between them are retained (p-*).
  await expect(main).toContainText("retained-answer-B", { timeout: 30_000 });
  const flipped =
    /prompt:msg-bf-\d+,thought:msg-p-[^,]+,plan:msg-p-[^,]+,answerA:msg-bf-\d+,thought:msg-p-[^,]+,answerB:msg-bf-\d+$/;
  await expect
    .poll(async () => (await probeOrder(page)).join(","), { timeout: 20_000 })
    .toMatch(flipped);

  // nothing may render past the final answer — the tail-clump regression
  const order = await probeOrder(page);
  const answerBIdx = order.findIndex((k) => k.startsWith("answerB"));
  expect(answerBIdx).toBe(order.length - 1);
  expect(order.filter((k) => k.startsWith("thought")).length).toBe(2);

  // a reload re-seeds from durable + itemlog — same positions, no dupes
  await page.reload();
  await expect(main).toContainText("retained-answer-B", { timeout: 30_000 });
  await expect
    .poll(async () => (await probeOrder(page)).join(","), { timeout: 20_000 })
    .toMatch(flipped);
  const body = await main.innerText();
  const count = (s: string) => body.split(s).length - 1;
  expect(count("retained-answer-A")).toBe(1);
  expect(count("retained-answer-B")).toBe(1);
});
