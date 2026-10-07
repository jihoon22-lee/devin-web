// Fake `devin acp` for daemon tests.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
// - Answers requests (initialize/session/* canned, others {ok:method}).
// - {"method":"TEST_EMIT", params:{line, delayMs?}} notification → writes the
//   line verbatim to stdout (optionally delayed) — injects agent->client traffic.
// - Any response it receives (id + result/error, no method) is echoed back out
//   as a {"method":"TEST_OBSERVED"} notification so tests can see what the
//   client/daemon answered to agent->client requests.
// - FAKE_ACP_SCRIPT=<path> (e2e only): on each session/prompt, re-reads the
//   JSON file and runs the first turn whose `match` substring appears in the
//   prompt text. Steps:
//     {"emit": <SessionUpdate>, "delayMs": n} → session/update notification
//     {"request": {"method","params"}}        → agent->client request; pauses
//                                               the script until the client
//                                               responds (15s fallback)
//   "$PROMPT" in emitted strings → the prompt's first text block; "$RESP" →
//   the optionId/result of the last answered request. After the steps the prompt
//   request gets its {stopReason:"end_turn"} response — i.e. the turn ends.
//   With no match (or no file) the prompt just resolves immediately.
// - configOptions: session/new|load and session/set_config_option return the
//   per-session config array (DEFAULT_CONFIG; FAKE_ACP_CONFIG=<path> replaces
//   it). set_config_option persists currentValue per session; fake-beta/
//   fake-gamma narrow thought_level to low/medium.
//   {"commit": {"role","text"}} → INSERT a message_nodes row into FAKE_ACP_DB
//   (sessions.db) + advance main_chain_id — simulates the real CLI's durable
//   commit so specs can exercise the durable/provisional flip.
if (process.env.FAKE_ACP_PID_FILE) writeFileSync(process.env.FAKE_ACP_PID_FILE, String(process.pid));
let buf = "";
const deferred = []; // responses held until TEST_FLUSH (params._defer)
const reqWaiters = new Map(); // script-emitted request id → resolve(response)
const activeTurns = new Map(); // sessionId → { cancel() } for scripted turns
const created = new Map(); // sessionId → list entry — fork/new results so session/list surfaces them
const cfgState = new Map(); // sessionId → { configId: currentValue } — set_config_option writes
let scriptReqSeq = 0;

// SessionConfigOption[] served on new/load/set_config_option.
// FAKE_ACP_CONFIG=<path> replaces the whole array (JSON file).
const DEFAULT_CONFIG = [
  {
    id: "mode",
    name: "Mode",
    type: "select",
    currentValue: "code",
    options: [
      { value: "code", name: "Code", _meta: { "cognition.ai/icon": "code" } },
      { value: "plan", name: "Plan", _meta: { "cognition.ai/icon": "file-text" } },
      { value: "bypass", name: "Bypass Permissions", _meta: { "cognition.ai/icon": "shield-off" } },
    ],
  },
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "fake-alpha",
    options: [
      { value: "fake-alpha", name: "Fake Alpha", _meta: { "cognition.ai/supportsImages": true } },
      { value: "fake-beta", name: "Fake Beta", _meta: { "cognition.ai/supportsImages": false } },
      { value: "fake-gamma", name: "Fake Gamma" },
    ],
  },
  {
    id: "thought_level",
    name: "Thinking",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
  {
    id: "speed",
    name: "Speed",
    category: "model_config",
    type: "select",
    currentValue: "standard",
    options: [
      { value: "standard", name: "Standard" },
      { value: "fast", name: "Fast" },
    ],
  },
];
// these models only offer low/medium thought levels
const LIMITED_THOUGHT_MODELS = new Set(["fake-beta", "fake-gamma"]);

function baseConfig() {
  const f = process.env.FAKE_ACP_CONFIG;
  if (f) {
    try {
      const doc = JSON.parse(readFileSync(f, "utf8"));
      if (Array.isArray(doc)) return doc;
    } catch {
      /* bad/missing override — fall back to the builtin */
    }
  }
  return DEFAULT_CONFIG;
}

/** Full configOptions array for a session — the base config deep-cloned,
 *  with the session's currentValues applied and thought_level narrowed to
 *  low/medium while a limited model is selected. Lazily seeds cfgState. */
function configFor(sessionId) {
  let state = cfgState.get(sessionId);
  if (!state) {
    state = {};
    cfgState.set(sessionId, state);
  }
  const opts = JSON.parse(JSON.stringify(baseConfig()));
  for (const o of opts) {
    if (o?.id != null && state[o.id] !== undefined) o.currentValue = state[o.id];
  }
  const model = opts.find((o) => o?.id === "model");
  const thought = opts.find((o) => o?.id === "thought_level");
  if (thought && LIMITED_THOUGHT_MODELS.has(model?.currentValue) && Array.isArray(thought.options)) {
    thought.options = thought.options.filter((o) => o.value === "low" || o.value === "medium");
    if (!thought.options.some((o) => o.value === thought.currentValue)) {
      thought.currentValue = "low";
      state[thought.id] = "low";
    }
  }
  return opts;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

// script {"commit":{role,text}} → append a durable row like the real CLI's
// post-turn commit; FAKE_ACP_DB points at the fixture's sessions.db
let commitDb = null;
function commitRow(sessionId, spec) {
  const f = process.env.FAKE_ACP_DB;
  if (!f) return;
  try {
    if (!commitDb) {
      commitDb = new DatabaseSync(f);
      // The web concurrently reads this rollback-journal fixture. Without
      // waiting for readers, SQLITE_BUSY silently drops a scripted commit.
      commitDb.exec("PRAGMA busy_timeout = 5000");
    }
    const max =
      commitDb
        .prepare("SELECT MAX(node_id) AS m FROM message_nodes WHERE session_id = ?")
        .get(sessionId)?.m ?? 0;
    const nid = max + 1;
    commitDb
      .prepare(
        "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
      )
      .run(
        sessionId,
        nid,
        max || null,
        JSON.stringify({
          message_id: `${sessionId}-live-${nid}`,
          role: spec.role ?? "assistant",
          content: [{ type: "text", text: spec.text ?? "" }],
        }),
        Math.floor(Date.now() / 1000),
      );
    commitDb.prepare("UPDATE sessions SET main_chain_id = ? WHERE id = ?").run(nid, sessionId);
  } catch {
    /* fixture db missing/locked — the step is a no-op */
  }
}

function subst(v, vars) {
  if (typeof v === "string") {
    return v.replace(/\$(PROMPT|RESP)\b/g, (m, k) => String(vars[k] ?? m));
  }
  if (Array.isArray(v)) return v.map((x) => subst(x, vars));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, vars)]));
  }
  return v;
}

async function runTurn(sessionId, promptText, promptId, steps) {
  if (process.env.FAKE_ACP_PROMPT_LOG) {
    appendFileSync(process.env.FAKE_ACP_PROMPT_LOG, JSON.stringify({ sessionId, promptText, pid: process.pid }) + "\n");
  }
  const vars = { PROMPT: promptText, RESP: "" };
  // cancellable turn — `session/cancel` (a notification) aborts the script and
  // resolves the prompt request with stopReason "cancelled", like the real CLI
  const ctx = { cancelled: false, wake: null };
  const cancelP = new Promise((res) => (ctx.wake = res));
  const wait = (ms) => Promise.race([sleep(ms), cancelP]);
  activeTurns.set(sessionId, {
    cancel: () => {
      ctx.cancelled = true;
      ctx.wake();
    },
  });
  try {
    for (const step of steps) {
      if (ctx.cancelled) break;
      if (step.delayMs) await wait(step.delayMs);
      if (ctx.cancelled) break;
      if (step.emit) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update: subst(step.emit, vars) },
        });
      } else if (step.commit) {
        commitRow(sessionId, subst(step.commit, vars));
      } else if (step.request) {
        const rid = step.request.id ?? `script-${++scriptReqSeq}`;
        write({
          jsonrpc: "2.0",
          id: rid,
          method: step.request.method,
          params: subst({ sessionId, ...step.request.params }, vars),
        });
        const resp = await Promise.race([
          new Promise((res) => reqWaiters.set(rid, res)),
          cancelP.then(() => null),
          sleep(step.request.timeoutMs ?? 15_000).then(() => null), // bounded scripted requests
        ]);
        if (ctx.cancelled) break;
        const outcome = resp?.result?.outcome;
        vars.RESP = outcome?.optionId ?? outcome?.outcome ?? "timeout";
      }
    }
  } finally {
    activeTurns.delete(sessionId);
    write({
      jsonrpc: "2.0",
      id: promptId,
      result: { stopReason: ctx.cancelled ? "cancelled" : "end_turn" },
    });
  }
}

function promptScript(promptText) {
  const f = process.env.FAKE_ACP_SCRIPT;
  if (!f) return null;
  try {
    const doc = JSON.parse(readFileSync(f, "utf8"));
    const turns = Array.isArray(doc) ? doc : doc.turns;
    if (!Array.isArray(turns)) return null;
    return (
      turns.find(
        (t) =>
          typeof t?.match === "string" && t.match.length > 0 && promptText.includes(t.match),
      ) ?? null
    );
  } catch {
    return null;
  }
}

process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id == null) {
      if (msg.method === "TEST_EMIT" && msg.params?.line) {
        const emit = () => {
          const bytes = Buffer.from(msg.params.line + "\n");
          if (msg.params.splitAt != null) {
            process.stdout.write(bytes.subarray(0, msg.params.splitAt));
            setTimeout(() => process.stdout.write(bytes.subarray(msg.params.splitAt)), 20);
          } else process.stdout.write(bytes);
        };
        if (msg.params.delayMs) setTimeout(emit, msg.params.delayMs);
        else emit();
      }
      if (msg.method === "TEST_FLUSH") {
        for (const r of deferred.splice(0)) process.stdout.write(r + "\n");
      }
      if (msg.method === "session/cancel") {
        activeTurns.get(msg.params?.sessionId)?.cancel();
      }
      continue;
    }
    if (msg.method == null) {
      reqWaiters.get(msg.id)?.(msg);
      reqWaiters.delete(msg.id);
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", method: "TEST_OBSERVED", params: { original: msg } }) + "\n",
      );
      continue;
    }
    let result;
    if (msg.method === "initialize") {
      // echo the revert flag like the real agent — the capability only
      // unlocks for clients that advertised it in clientCapabilities._meta
      const advertised = msg.params?.clientCapabilities?._meta?.["cognition.ai/revert"] === true;
      result = {
        protocolVersion: 1,
        fakeInit: true,
        agentCapabilities: { _meta: advertised ? { "cognition.ai/revert": true } : {} },
      };
    }
    else if (msg.method === "session/new") {
      result = { sessionId: "s-fake-1", configOptions: configFor("s-fake-1") };
      created.set("s-fake-1", { sessionId: "s-fake-1", cwd: msg.params?.cwd ?? "", title: null });
    }
    else if (msg.method === "session/fork") {
      // a fork inherits the parent's config values
      const parent = cfgState.get(msg.params?.sessionId);
      if (parent) cfgState.set("s-fake-fork", { ...parent });
      result = { sessionId: "s-fake-fork", configOptions: configFor("s-fake-fork") };
      created.set("s-fake-fork", { sessionId: "s-fake-fork", cwd: msg.params?.cwd ?? "", title: "Forked session" });
    }
    // revert surface — FAKE_ACP_STEPS_FILE maps sessionId → RevertStepInfo[]
    // ({stepId,stepNumber,questionNodeId,forkTargetNodeId,...}); forkFromStep
    // answers {forkedSessionId} like the real RevertForkFromStepResponse
    else if (msg.method === "_cognition.ai/revert/listSteps") {
      const f = process.env.FAKE_ACP_STEPS_FILE;
      let all = {};
      try { all = f ? JSON.parse(readFileSync(f, "utf8")) : {}; } catch { all = {}; }
      result = { steps: all[msg.params?.sessionId] ?? [] };
    }
    else if (msg.method === "_cognition.ai/revert/forkFromStep") {
      const id = `s-fake-forked-${msg.params?.targetNodeId ?? "x"}`;
      created.set(id, { sessionId: id, cwd: "", title: `Forked at node ${msg.params?.targetNodeId}` });
      result = { forkedSessionId: id };
    }
    else if (msg.method === "session/load") {
      // a locked session refuses load like the real CLI — the web's attach
      // path then falls back to the read-only transcript
      const f = process.env.FAKE_ACP_SESSIONS_FILE;
      const locked = f
        ? JSON.parse(readFileSync(f, "utf8")).some(
            (s) => s.sessionId === msg.params?.sessionId && s._meta?.["cognition.ai/isLocked"],
          )
        : false;
      if (locked) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: "session_locked: already open in another process" },
          }) + "\n",
        );
        continue;
      }
      const ent = created.get(msg.params?.sessionId);
      if (ent && msg.params?.cwd) ent.cwd = msg.params.cwd;
      result = {
        modes: { currentModeId: "plan" },
        configOptions: configFor(msg.params?.sessionId),
      };
    }
    else if (msg.method === "session/set_config_option") {
      // {sessionId, configId, value} → echo the session's full configOptions;
      // switching to a limited model narrows thought_level (see configFor).
      // Unknown configIds are remembered but change nothing in the array.
      const sid = msg.params?.sessionId;
      const st = cfgState.get(sid) ?? {};
      cfgState.set(sid, st);
      if (msg.params?.configId != null) st[msg.params.configId] = msg.params?.value;
      result = { configOptions: configFor(sid) };
    }
    else if (msg.method === "session/delete") result = {};
    else if (msg.method === "session/list") {
      // e2e: the fixture's session list (e2e/fixtures/make-fixture.mjs) plus
      // sessions this process created (session/new, fork, forkFromStep)
      const f = process.env.FAKE_ACP_SESSIONS_FILE;
      const file = f ? JSON.parse(readFileSync(f, "utf8")) : [];
      result = { sessions: [...file, ...created.values()] };
    } else if (msg.method === "session/prompt") {
      const text = (msg.params?.prompt ?? []).find((b) => b?.type === "text")?.text ?? "";
      const turn = promptScript(text);
      if (turn) {
        void runTurn(msg.params?.sessionId, text, msg.id, turn.steps);
        continue;
      }
      result = { stopReason: "end_turn" };
    }
    else result = { ok: msg.method };
    const out = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
    if (msg.params?._defer) deferred.push(out);
    else process.stdout.write(out + "\n");
  }
});
process.stdin.resume();
