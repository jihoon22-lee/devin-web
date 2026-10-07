import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fixtureEnvironment, fixturePaths } from "../fixtures/environment.mjs";

const repository = resolve(__dirname, "../..");
const fixture = fixturePaths(repository, true);
const env = fixtureEnvironment(fixture);
const SID = "e2e-session-live";
const headers = { "x-devin-web": "1" };
const run = promisify(execFile);
const pid = (name: string) => Number(readFileSync(join(fixture.root, name), "utf8"));
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

// The private host channel supports concurrent readers. Never connect a second
// ACP client: that would displace the very bridge whose survival we are testing.
function terminalSnapshot(id: string): Promise<{ output: string; exited: boolean }> {
  return new Promise((resolveSnapshot, reject) => {
    const socket = net.connect(join(fixture.state, "host.sock"));
    let buffer = "";
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.setTimeout(5_000, () => fail(new Error("fixture host snapshot timed out")));
    socket.on("error", fail);
    socket.on("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "term/snapshot", params: { id } }) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.id !== 1) continue;
        socket.destroy();
        if (message.error) reject(new Error(message.error.message));
        else resolveSnapshot(message.result);
      }
    });
  });
}

// Tests the installed production control path, not a replacement restart stub.
// Its own fixture daemon remains alive while ctl replaces only the web group.
test("web restart preserves daemon, agent, PTY, permission and exactly-once queued turn", async ({ page, request }) => {
  writeFileSync(join(fixture.root, "turn-script.json"), JSON.stringify({ turns: [
    { match: "restart-active", steps: [
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before-web-restart" } } },
      { request: { id: "fixture-reused-rpc-id", method: "session/request_permission", timeoutMs: 120_000, params: {
        toolCall: { toolCallId: "restart-tool", title: "Fixture permission across restart" },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
      } } },
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " after-web-restart answer=$RESP" } } },
      { commit: { role: "user", text: "restart-active" } },
      { commit: { role: "assistant", text: "before-web-restart after-web-restart answer=$RESP" } },
    ] },
    { match: "restart-queued", steps: [
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "queued-drained-once" } } },
      { commit: { role: "user", text: "restart-queued" } },
      { commit: { role: "assistant", text: "queued-drained-once" } },
    ] },
    { match: "restart-reused-request", steps: [
      { request: { id: "fixture-reused-rpc-id", method: "session/request_permission", timeoutMs: 120_000, params: {
        toolCall: { toolCallId: "new-tool", title: "A new request reusing the RPC ID" },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
      } } },
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new-request-answer=$RESP" } } },
    ] },
  ] }));
  expect((await request.post(`/api/sessions/${SID}/load`, { headers, data: { cwd: fixture.project } })).ok()).toBe(true);
  await page.goto(`/?s=${SID}`);
  await expect(page.locator("main")).toContainText("live-turn spec seed");

  // A real host PTY writes its own PID and emits monotonically increasing text.
  const ticker = join(fixture.root, "ticker.sh");
  writeFileSync(ticker, `echo $$ > ${quote(join(fixture.root, "pty.pid"))}\nn=0\nwhile true; do echo "fixture-pty-tick:$n"; n=$((n+1)); sleep 0.2; done\n`);
  const created = await request.post("/api/terminals", { headers, data: { cwd: fixture.project, sessionId: SID } });
  expect(created.ok()).toBe(true);
  const { terminalId } = await created.json();
  try {
    expect((await request.post(`/api/terminals/${terminalId}/input`, {
      headers, data: { data: `exec bash --noprofile --norc ${quote(ticker)}\n` },
    })).ok()).toBe(true);
    await expect.poll(() => { try { return pid("pty.pid"); } catch { return 0; } }).toBeGreaterThan(0);
    await expect.poll(async () => (await terminalSnapshot(terminalId)).output).toContain("fixture-pty-tick:2");

    await page.locator("textarea").fill("restart-active");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const card = page.locator("[data-perm-pending]");
    await expect(card).toBeVisible();
    await expect(page.locator("main")).toContainText("before-web-restart");
    const queued = await request.post(`/api/sessions/${SID}/prompt`, { headers, data: { text: "restart-queued" } });
    expect(queued.ok()).toBe(true);
    expect(await queued.json()).toHaveProperty("queued", true);

    const before = { daemon: pid("state/acpd.pid"), agent: pid("agent.pid"), pty: pid("pty.pid"), web: pid("state/pid") };
    const outputBefore = (await terminalSnapshot(terminalId)).output;
    const { stdout } = await run(join(repository, "bin/devin-web-ctl"), ["restart"], { cwd: repository, env, timeout: 60_000 });
    expect(stdout).toContain("devin-web up");
    expect(pid("state/pid")).not.toBe(before.web);
    expect(pid("state/acpd.pid")).toBe(before.daemon);
    expect(pid("agent.pid")).toBe(before.agent);
    expect(pid("pty.pid")).toBe(before.pty);
    for (const livePid of [before.daemon, before.agent, before.pty]) expect(() => process.kill(livePid, 0)).not.toThrow();
    const outputAfter = await terminalSnapshot(terminalId);
    expect(outputAfter.exited).toBe(false);
    expect(outputAfter.output.length).toBeGreaterThan(outputBefore.length);
    expect(outputAfter.output).toContain("fixture-pty-tick:2");
    console.log("verified fixture process continuity", before, { webAfter: pid("state/pid") });
    expect((await request.get(`/api/terminals?sessionId=${SID}`)).ok()).toBe(true);

    // Full navigation drops browser memory, proving daemon replay restores the
    // pending permission and the persisted queue through a fresh web process.
    await page.reload();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("main")).toContainText("before-web-restart");
    const answered = page.waitForRequest((r) => r.url().endsWith(`/api/sessions/${SID}/respond`));
    await card.getByRole("button", { name: "Allow once" }).click();
    const answeredBody = (await answered).postDataJSON();
    await expect(page.locator("main")).toContainText("after-web-restart answer=allow", { timeout: 30_000 });
    await expect(page.locator("main")).toContainText("queued-drained-once", { timeout: 30_000 });
    await expect(card).toHaveCount(0);
    const prompts = readFileSync(join(fixture.root, "prompts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(prompts.filter((entry) => entry.promptText === "restart-active")).toHaveLength(1);
    expect(prompts.filter((entry) => entry.promptText === "restart-queued")).toHaveLength(1);
    expect(prompts.every((entry) => entry.pid === before.agent)).toBe(true);
    // Completed request IDs are expired; stale tabs cannot answer them again.
    expect((await request.post(`/api/sessions/${SID}/respond`, { headers, data: answeredBody })).status()).toBe(404);
    await page.reload();
    await expect(page.locator("main")).toContainText("queued-drained-once");
    expect((await page.locator("main").innerText()).split("queued-drained-once")).toHaveLength(2);

    // JSON-RPC permits recycling a completed wire ID. An old tab's answer
    // must not accidentally approve a later request that happens to reuse it.
    expect((await request.post(`/api/sessions/${SID}/prompt`, {
      headers, data: { text: "restart-reused-request" },
    })).ok()).toBe(true);
    await expect(card).toBeVisible();
    expect((await request.post(`/api/sessions/${SID}/respond`, { headers, data: answeredBody })).status()).toBe(404);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Allow once" }).click();
    await expect(page.locator("main")).toContainText("new-request-answer=allow");
    await expect(card).toHaveCount(0);
  } finally {
    // Even a failed assertion releases the fixture terminal. The webServer
    // owner independently stops all fixture groups on test/setup failure.
    await request.delete(`/api/terminals/${terminalId}`, { headers, timeout: 5_000 }).catch(() => {});
  }
});
