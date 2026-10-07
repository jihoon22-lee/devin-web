// e2e fixture — a tiny CLI data dir, a private state dir and a fake `devin`,
// so the Playwright smoke never touches ~/.local/share/devin, the real
// search.db, or a real agent. Rebuilt from scratch on every run.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureEnvironment, fixturePaths } from "./environment.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = fixturePaths(ROOT, process.argv.includes("--daemon"));
const FIX = fixture.root;
const env = fixtureEnvironment(fixture);
rmSync(FIX, { recursive: true, force: true });
for (const d of ["cli", "cli/session_locks", "state", "project", "home", "config/devin", "data", "xdg-state", "cache", "tmp"]) {
  mkdirSync(join(FIX, d), { recursive: true });
}

writeFileSync(fixture.devinConfig, "{}\n");
const CWD = join(FIX, "project");
const now = Math.floor(Date.now() / 1000);

const db = new DatabaseSync(join(FIX, "cli", "sessions.db"));
db.exec(`CREATE TABLE sessions(
  id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
  model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT)`);
db.exec(`CREATE TABLE message_nodes(
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id))`);

const insNode = db.prepare(
  "INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)",
);
const insSession = db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)");
const put = (sid, i, role, text) =>
  insNode.run(sid, i, i === 1 ? null : i - 1,
    JSON.stringify({ message_id: `${sid}-m${i}`, role, content: [{ type: "text", text }] }),
    now - 3600 + i);
const putAt = (sid, nid, parent, role, text, ts) =>
  insNode.run(sid, nid, parent,
    JSON.stringify({ message_id: `${sid}-m${nid}`, role, content: [{ type: "text", text }] }),
    ts);

// ONE session per spec file. The web process keeps a per-session event ring
// that replays live events into later viewers — a shared id would leak one
// spec's prompts into another spec's transcript, so ids carry the spec name
// (a failure names its owner). Never reuse another spec's session, even for
// read-only opens.
const seedShort = (sid, title, msgs, age = 3600) => {
  msgs.forEach(([role, text], i) => put(sid, i + 1, role, text));
  insSession.run(sid, CWD, "local", "fake", "default", now - age, now - (3600 - age), title, msgs.length, 0, null);
};

seedShort("e2e-session-reconnect", "E2E reconnect session", [
  ["user", "Please summarize how the stream mux handles a reconnect."],
  ["assistant", "Each subscription cursor rewinds to the browser's Last-Event-ID."],
  ["user", "And what happens to the transcript that is already on screen?"],
  ["assistant", "The rendered transcript stays exactly where it was after reconnecting."],
]);
seedShort("e2e-session-live", "E2E live-turn session", [
  ["user", "live-turn spec seed — transcript pipeline check"],
  ["assistant", "live-turn spec seed reply"],
]);
seedShort("e2e-session-turnrc", "E2E turn-reconnect session", [
  ["user", "turn-reconnect spec seed — survives a mid-turn cut"],
  ["assistant", "turn-reconnect spec seed reply"],
]);
seedShort("e2e-session-mirror", "E2E multi-client session", [
  ["user", "multi-client spec seed — fanout check"],
  ["assistant", "multi-client spec seed reply"],
]);
// panels spec: the count test needs exactly 4 nodes and never prompts, and
// the palette test needs a searchable phrase in a message body
seedShort("e2e-session-panels", "E2E panels session", [
  ["user", "panels spec seed one"],
  ["assistant", "Search can find Last-Event-ID inside this message body."],
  ["user", "panels spec seed two"],
  ["assistant", "panels spec seed reply two"],
]);
seedShort("e2e-session-drawer", "E2E drawer session", [
  ["user", "drawer spec seed — sidebar entry"],
  ["assistant", "drawer spec seed reply"],
]);
seedShort("e2e-session-tworegion", "E2E two-region session", [
  ["user", "two-region spec seed — cut mid-turn, reconnect, no duplicates"],
  ["assistant", "two-region spec seed reply"],
]);
seedShort("e2e-session-archive", "E2E archive session", [
  ["user", "archive spec seed — hide from the list, keep the transcript"],
  ["assistant", "archive spec seed reply"],
]);
seedShort("e2e-session-reqpos", "E2E request-position session", [
  ["user", "reqpos spec seed — permission card must sit where it was asked"],
  ["assistant", "reqpos spec seed reply"],
]);
seedShort("e2e-session-retained", "E2E retained session", [
  ["user", "retained spec seed — thinking keeps its place after the turn"],
  ["assistant", "retained spec seed reply"],
]);

seedShort("e2e-session-mentions", "E2E mention session", [
  ["user", "mention spec seed"], ["assistant", "mention spec reply"],
]);
seedShort("e2e-session-config-plan", "E2E config-plan session", [
  ["user", "config-plan spec seed"],
  ["assistant", "config-plan spec seed reply"],
]);
seedShort("e2e-session-sendnow", "E2E send-now session", [
  ["user", "send-now spec seed"],
  ["assistant", "send-now spec seed reply"],
]);

// long session — "Load earlier" pagination (120 nodes → two extra pages)
const LONG = "e2e-session-long";
for (let i = 1; i <= 120; i++) {
  put(LONG, i, i % 2 ? "user" : "assistant", `e2e-history message number ${i} ${i % 2 ? "asks" : "answers"}`);
}
insSession.run(LONG, CWD, "local", "fake", "default", now - 3500, now - 10, "E2E long session", 120, 0, null);

// Search jump owns a separate long session; an in-window row shares the
// old hit's first 40 characters so a text-prefix jump chooses incorrectly.
const JUMP = "e2e-session-searchjump";
const jumpPrefix = "Let me check the configuration file before changing anything else here";
for (let i = 1; i <= 120; i++) {
  const text = i === 7 ? `${jumpPrefix} ancientneedle` : i === 90 ? `${jumpPrefix} newer` : `jump history row ${i}`;
  put(JUMP, i, i % 2 ? "user" : "assistant", text);
}
insSession.run(JUMP, CWD, "local", "fake", "default", now - 3500, now - 10, "E2E search jump session", 120, 0, null);

// locked session — held by the fake devin process spawned below
const LOCKED = "e2e-session-locked";
[
  ["user", "This session is open in another devin process."],
  ["assistant", "So the web must show it read-only until takeover."],
].forEach(([role, text], i) => put(LOCKED, i + 1, role, text));
insSession.run(LOCKED, CWD, "local", "fake", "default", now - 3400, now - 20, "E2E locked session", 2, 0, null);

// tree spec — a branched forest in one session: nodes 1→2 are the orphaned
// pre-compaction tree, 10→…→13 the post-compaction main chain (root 10's
// parent is NULL), and 14 a fork child off 11 — so node 11 is a branch
// point and the tree API must report two trees
const TREE = "e2e-session-tree";
const t0 = now - 7200;
putAt(TREE, 1, null, "user", "tree spec — the ORIGINAL pre-compaction question", t0 + 1);
putAt(TREE, 2, 1, "assistant", "tree spec — the original answer before compression", t0 + 2);
const t1 = now - 3600;
putAt(TREE, 10, null, "user", "tree spec — post-compression first question", t1 + 10);
putAt(TREE, 11, 10, "assistant", "tree spec — post-compression first answer", t1 + 11);
putAt(TREE, 12, 11, "user", "tree spec — follow-up on the main line", t1 + 12);
putAt(TREE, 13, 12, "assistant", "tree spec — main-line answer", t1 + 13);
putAt(TREE, 14, 11, "user", "tree spec — the ALTERNATE branch question", t1 + 14);
insSession.run(TREE, CWD, "local", "fake", "default", now - 7000, now - 100, "E2E tree session", 13, 0, null);
db.close();

// revert steps for fake-acp's cognition.ai/revert/listSteps — step spans
// follow the main chain: [10..11]→anchor 11, [12..13]→anchor 13
writeFileSync(join(FIX, "steps.json"), JSON.stringify({
  [TREE]: [
    { stepId: "s1", stepNumber: 1, kind: "prompt", questionNodeId: 10, forkTargetNodeId: 11 },
    { stepId: "s2", stepNumber: 2, kind: "prompt", questionNodeId: 12, forkTargetNodeId: 13 },
  ],
}));

// A LIVE process whose argv0 is `devin` — lockOwner() resolves it as a real
// holder (alive + isDevin). Reaped by e2e globalTeardown via lock-holder.pid.
if (!fixture.daemon) {
const holder = spawn("bash", ["-c", "exec -a devin sleep 7200"], {
  env,
  detached: true,
  stdio: "ignore",
});
holder.unref();
writeFileSync(join(FIX, "cli", "session_locks", `${LOCKED}.lock`), `${holder.pid}\n`);
writeFileSync(join(FIX, "lock-holder.pid"), `${holder.pid}\n`);
}

// what fake-acp answers to session/list (FAKE_ACP_SESSIONS_FILE)
const listEntry = (sessionId, title, extra = {}) => ({
  sessionId, cwd: CWD, title, updatedAt: new Date(now * 1000).toISOString(), ...extra,
});
writeFileSync(join(FIX, "sessions.json"), JSON.stringify([
  listEntry("e2e-session-reconnect", "E2E reconnect session"),
  listEntry("e2e-session-live", "E2E live-turn session"),
  listEntry("e2e-session-turnrc", "E2E turn-reconnect session"),
  listEntry("e2e-session-mirror", "E2E multi-client session"),
  listEntry("e2e-session-panels", "E2E panels session"),
  listEntry("e2e-session-drawer", "E2E drawer session"),
  listEntry("e2e-session-tworegion", "E2E two-region session"),
  listEntry("e2e-session-archive", "E2E archive session"),
  listEntry("e2e-session-reqpos", "E2E request-position session"),
  listEntry("e2e-session-retained", "E2E retained session"),
  listEntry(JUMP, "E2E search jump session"),
  listEntry("e2e-session-mentions", "E2E mention session"),
  listEntry("e2e-session-config-plan", "E2E config-plan session"),
  listEntry("e2e-session-sendnow", "E2E send-now session"),
  listEntry(LONG, "E2E long session"),
  listEntry(TREE, "E2E tree session"),
  // cognition.ai/isLocked drives the read-only + Take over path; the
  // session_locks pid file below supplies the owner details
  listEntry(LOCKED, "E2E locked session", { _meta: { "cognition.ai/isLocked": true } }),
]));

const fakeDevin = join(FIX, "fake-devin");
writeFileSync(fakeDevin, `#!/bin/sh
# e2e stand-in for the devin CLI — see e2e/fixtures/make-fixture.mjs
case "$1" in
  acp) exec node "${join(ROOT, "test", "fixtures", "fake-acp.mjs")}" ;;
  --version) echo "devin 0.0.0-e2e (fake)" ;;
  auth) echo "Logged in (e2e fake)" ;;
  *) exit 1 ;;
esac
`);
chmodSync(fakeDevin, 0o755);

// project tree for the Files tab + a real git repo with one dirty file for
// the Changes tab
mkdirSync(join(CWD, "src"), { recursive: true });
writeFileSync(join(CWD, "README.md"), "# e2e project\n\nfixture-readme-marker\n");
writeFileSync(join(CWD, "src", "main.ts"), "export const fixtureMarker = 'e2e-file-content';\n");
const git = (args) => execFileSync("git", ["-C", CWD, ...args], { stdio: "pipe", env });
git(["init", "-q"]);
git(["-c", "user.email=e2e@fixture", "-c", "user.name=e2e", "add", "-A"]);
git(["-c", "user.email=e2e@fixture", "-c", "user.name=e2e", "commit", "-qm", "init"]);
writeFileSync(join(CWD, "README.md"), "# e2e project\n\nfixture-readme-marker\n\nmodified line for the diff view\n");

console.log(`e2e fixture ready at ${FIX}`);
