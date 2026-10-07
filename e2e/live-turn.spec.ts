import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Live-turn flows against the fake agent's scripted turns (FAKE_ACP_SCRIPT —
 *  see test/fixtures/fake-acp.mjs). Each spec writes the script fresh and keys
 *  its turn by a `match` substring in the prompt text, so tests don't share
 *  agent state. */

const FIX = join(process.cwd(), ".e2e-fixture");
const SCRIPT = join(FIX, "turn-script.json");
// every spec owns exactly one fixture session — the server's per-session
// ring replays live events into later viewers, so ids must never be shared
const SID = "e2e-session-live";
const CWD = join(FIX, "project");

const writeScript = (turns: unknown[]) =>
  writeFileSync(SCRIPT, JSON.stringify({ turns }));

/** Attach the fixture session (deterministic — auto-attach races the first
 *  prompt) and open it in the chat view with the stream subscribed. */
async function openSession(page: Page, request: APIRequestContext) {
  const res = await request.post(`/api/sessions/${SID}/load`, {
    data: { cwd: CWD },
    headers: { "x-devin-web": "1" }, // same CSRF marker the client api() sends
  });
  expect(res.ok()).toBeTruthy();
  await page.goto(`/?s=${SID}`);
  // seeded fixture rows prove the subscription + render pipeline is up
  await expect(
    page.locator("main"),
    "fixture transcript should seed",
  ).toContainText("live-turn spec seed", { timeout: 30_000 });
}

async function send(page: Page, text: string) {
  await page.locator("textarea").fill(text);
  // busy state renames the button to "Queue message" — same control
  await page.getByRole("button", { name: /^(Send|Queue message)$/ }).click();
}

test.beforeEach(() => rmSync(SCRIPT, { force: true }));
test.afterEach(() => rmSync(SCRIPT, { force: true }));

test("prompt renders ONE user bubble even when the agent relays the same user_message", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  writeScript([
    {
      match: "echo-dedup-probe",
      steps: [
        // the real CLI relays the user's message back as a session_update —
        // same text as the server's synthetic echo, different seq
        { delayMs: 80, emit: { sessionUpdate: "user_message", content: [{ type: "text", text: "$PROMPT" }] } },
        { delayMs: 80, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "e2e-dedup reply" } } },
      ],
    },
  ]);
  await openSession(page, request);
  await send(page, "echo-dedup-probe: one bubble only");

  const bubbles = page.locator("main div.self-end", { hasText: "echo-dedup-probe" });
  await expect(page.locator("main")).toContainText("e2e-dedup reply", { timeout: 20_000 });
  await expect(page.locator("role=status")).toHaveCount(0, { timeout: 20_000 }); // turn ended
  await expect(bubbles).toHaveCount(1);
});

test("streamed chunks render once and the status bar clears at turn end", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  writeScript([
    {
      match: "stream-probe",
      steps: [
        { delayMs: 60, emit: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking about the probe" } } },
        { delayMs: 120, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "e2e-stream alpha " } } },
        { delayMs: 120, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "beta " } } },
        { delayMs: 300, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "omega-tail" } } },
      ],
    },
  ]);
  await openSession(page, request);
  await send(page, "stream-probe please");

  // mid-turn: status bar up with the activity word
  const status = page.locator("role=status");
  await expect(status).toBeVisible({ timeout: 10_000 });
  await expect(status).toContainText(/Working|writing|thinking/);

  const reply = page.locator("main", { hasText: "omega-tail" });
  await expect(reply).toContainText("e2e-stream alpha beta omega-tail", { timeout: 20_000 });
  // one message item, not one per chunk — .dw-virt wraps each ChatItem
  await expect(page.locator("main .dw-virt", { hasText: "e2e-stream" })).toHaveCount(1);
  await expect(status).toHaveCount(0, { timeout: 20_000 });
});

test("permission card approves the agent request and the turn continues", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  writeScript([
    {
      match: "perm-probe",
      steps: [
        { delayMs: 60, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I need to run something." } } },
        {
          request: {
            method: "session/request_permission",
            params: {
              toolCall: {
                toolCallId: "tc-e2e-1",
                title: "Run e2e probe command",
                kind: "execute",
                status: "pending",
                rawInput: { command: "rm -rf /tmp/e2e-nope" },
              },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "deny", name: "Reject", kind: "reject_once" },
              ],
            },
          },
        },
        { delayMs: 60, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "e2e-after-permission outcome=$RESP" } } },
      ],
    },
  ]);
  await openSession(page, request);
  await send(page, "perm-probe: ask me first");

  const card = page.locator("[data-perm-pending]");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("Run e2e probe command");
  await expect(card).toContainText("rm -rf /tmp/e2e-nope");
  await expect(page.locator("role=status")).toContainText("needs permission");

  await card.getByRole("button", { name: /Allow/ }).click();
  await expect(page.locator("[data-perm-pending]")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator("main")).toContainText("e2e-after-permission outcome=allow", {
    timeout: 20_000,
  });
  await expect(page.locator("role=status")).toHaveCount(0, { timeout: 20_000 });
});

test("a prompt sent mid-turn queues, then runs after turn_end", async ({ page, request }) => {
  test.setTimeout(120_000);
  writeScript([
    {
      match: "queue-first",
      steps: [
        { delayMs: 60, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "e2e-queue first reply" } } },
        { delayMs: 1200 }, // stay busy long enough to park the next prompt
      ],
    },
    {
      match: "queue-second",
      steps: [
        { delayMs: 60, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "e2e-queue second reply" } } },
      ],
    },
  ]);
  await openSession(page, request);
  await send(page, "queue-first probe");
  await expect(page.locator("role=status")).toContainText("Working", { timeout: 10_000 });

  await send(page, "queue-second probe");
  const status = page.locator("role=status");
  await expect(status).toContainText("+1 queued", { timeout: 10_000 });

  // turn 1 ends → the queued prompt fires itself and its bubble renders
  await expect(page.locator("main")).toContainText("e2e-queue first reply", { timeout: 20_000 });
  await expect(page.locator("main div.self-end", { hasText: "queue-second probe" })).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(page.locator("main")).toContainText("e2e-queue second reply", { timeout: 20_000 });
  await expect(status).toHaveCount(0, { timeout: 20_000 });
});

test("Stop cancels the in-flight turn and clears the status bar", async ({ page, request }) => {
  test.setTimeout(120_000);
  writeScript([
    {
      match: "cancel-probe",
      steps: [
        { delayMs: 60, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "e2e-cancel partial" } } },
        { delayMs: 30_000 }, // hung turn — only session/cancel ends it
      ],
    },
  ]);
  await openSession(page, request);
  await send(page, "cancel-probe then stop it");

  await expect(page.locator("main")).toContainText("e2e-cancel partial", { timeout: 15_000 });
  const status = page.locator("role=status");
  await expect(status).toContainText("Working");

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(status).toHaveCount(0, { timeout: 15_000 });
  // the partial reply stays — cancel freezes the transcript, it doesn't erase
  await expect(page.locator("main")).toContainText("e2e-cancel partial");
});

test("user_message_chunk halves matching the echo render as one bubble", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  writeScript([
    {
      match: "chunk-echo",
      steps: [
        { delayMs: 60, emit: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "chunk-echo" } } },
        { delayMs: 60, emit: { sessionUpdate: "user_message_chunk", content: { type: "text", text: " probe halves" } } },
        { delayMs: 60, emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "e2e-chunk reply" } } },
      ],
    },
  ]);
  await openSession(page, request);
  await send(page, "chunk-echo probe halves");

  await expect(page.locator("main")).toContainText("e2e-chunk reply", { timeout: 20_000 });
  await expect(
    page.locator("main div.self-end", { hasText: "chunk-echo probe halves" }),
  ).toHaveCount(1);
});
