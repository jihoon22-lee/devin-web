#!/usr/bin/env node
// Linux process ownership. PID alone is never authority to signal a process.
import { readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stateDir } from "../lib/paths.mjs";

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const scripts = { web: "devin-web.mjs", acpd: "devin-acpd.mjs", watch: "devin-web-watch.mjs", idle: "devin-web-idle-restart.mjs" };
const sidecar = (file) => `${file}.identity.json`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function configuration(role, env = process.env, argv = []) {
  const state = resolve(env.DEVIN_WEB_STATE_DIR || stateDir());
  const result = { root: ROOT, state, role };
  if (role !== "acpd") {
    const option = (long, short, fallback) => {
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === long || argv[i] === short) return argv[i + 1];
        if (argv[i].startsWith(`${long}=`)) return argv[i].slice(long.length + 1);
      }
      return fallback;
    };
    Object.assign(result, { port: String(Number(option("--port", "-p", env.DEVIN_WEB_PORT ?? env.PORT ?? "7100"))), dist: resolve(ROOT, env.DEVIN_WEB_DIST_DIR ?? ".next") });
    if (role === "web") Object.assign(result, { host: option("--host", "-H", "127.0.0.1"), acpd: env.DEVIN_WEB_ACPD ?? "1" });
  }
  if (role === "acpd" || role === "idle" || (role === "web" && env.DEVIN_WEB_ACPD !== "0")) {
    Object.assign(result, { acpSocket: resolve(env.DEVIN_WEB_ACP_SOCK ?? join(state, "acp.sock")), hostSocket: resolve(env.DEVIN_WEB_HOST_SOCK ?? join(state, "host.sock")) });
  }
  if (role === "acpd") Object.assign(result, { bin: env.DEVIN_WEB_DEVIN_BIN ?? "devin", fsRoots: env.DEVIN_WEB_FS_ROOTS ?? "" });
  return result;
}

function pidFromFile(file) {
  const value = readFileSync(file, "utf8").trim();
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 1) throw new Error("invalid PID");
  return Number(value);
}

function processEnvironment(pid) {
  return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map(entry => { const i = entry.indexOf("="); return [entry.slice(0, i), entry.slice(i + 1)]; }));
}

function identity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // comm is parenthesized and may itself contain spaces or closing parens.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z" || fields[0] === "X") throw Object.assign(new Error("process exited"), { code: "ESRCH" });
  const result = { pid, launchId: processEnvironment(pid).DEVIN_WEB_LAUNCH_ID ?? null, startTime: fields[19], pgid: Number(fields[2]), session: Number(fields[3]), bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), uid: readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1], exe: readlinkSync(`/proc/${pid}/exe`), argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) };
  const after = readFileSync(`/proc/${pid}/stat`, "utf8");
  const final = after.slice(after.lastIndexOf(")") + 2).split(" ");
  if (final[0] === "Z" || final[0] === "X") throw Object.assign(new Error("process exited"), { code: "ESRCH" });
  if (final[19] !== fields[19] || final[2] !== fields[2] || final[3] !== fields[3]) throw new Error("process identity changed while reading");
  return result;
}

function observedConfiguration(pid, role, current) {
  if (!scripts[role] || !current.argv[1] || current.exe !== realpathSync(process.execPath)) throw new Error("process executable/role does not match");
  const script = realpathSync(current.argv[1]);
  let args;
  if (script === join(ROOT, "bin", scripts[role])) args = current.argv.slice(2);
  else if (script === fileURLToPath(import.meta.url) && current.argv[2] === "launch" && current.argv[4] === role) args = current.argv.slice(5);
  else throw new Error("process role/root does not match");
  const env = processEnvironment(pid);
  if (!env.DEVIN_WEB_STATE_DIR || resolve(env.DEVIN_WEB_STATE_DIR) !== resolve(stateDir())) throw new Error("process state directory does not match");
  return configuration(role, env, args);
}

function publish(file, record) {
  const tmp = `${sidecar(file)}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record) + "\n", { mode: 0o600 });
  renameSync(tmp, sidecar(file));
  writeFileSync(file, String(record.pid), { mode: 0o600 });
}

export function writeProcessIdentity(file, role, env = process.env, argv = process.argv.slice(2)) {
  const record = { ...identity(process.pid), config: configuration(role, env, argv) };
  publish(file, record);
  return record;
}

// Explicit migration only: verify live argv/root/state/config before adding a
// sidecar. Never used as an automatic fallback by ctl or a watcher.
export function adoptProcessIdentity(file, role) {
  const pid = pidFromFile(file), current = identity(pid);
  const config = observedConfiguration(pid, role, current);
  if (!same(config, configuration(role)) || !same(current, identity(pid)) || pidFromFile(file) !== pid) throw new Error("process configuration/identity changed");
  const record = { ...current, config };
  publish(file, record);
  return record;
}

export function processOwnership(file, role) {
  let pid;
  try { pid = pidFromFile(file); } catch (error) { return { status: error.code === "ENOENT" ? "absent" : "unverified" }; }
  let current;
  try { current = identity(pid); } catch (error) { return { status: ["ENOENT", "ESRCH"].includes(error.code) ? "dead" : "unverified" }; }
  try {
    const record = JSON.parse(readFileSync(sidecar(file), "utf8"));
    const { config, ...saved } = record;
    if (!same(saved, current) || !same(config, configuration(role))) return { status: "unverified" };
    return { status: "owned", record };
  } catch { return { status: "unverified" }; }
}

export function removeProcessIdentity(file, record) {
  try {
    if (pidFromFile(file) === record.pid && same(JSON.parse(readFileSync(sidecar(file), "utf8")), record)) {
      rmSync(file, { force: true }); rmSync(sidecar(file), { force: true });
    }
  } catch {}
}

function matchesProcess(record) {
  try { return same(identity(record.pid), record); } catch { return false; }
}

// Walk only the verified leader's children, never a global process-name scan.
// Snapshot each child's own start identity while parent links and group/session
// still prove membership. These identities remain usable after reparenting.
function shutdownTargets(record) {
  const leader = { ...record };
  delete leader.config;
  const targets = [leader];
  if (leader.pgid !== leader.pid || leader.session !== leader.pid) return targets;
  const queue = [leader], seen = new Set([leader.pid]);
  while (queue.length) {
    const parent = queue.shift();
    if (!matchesProcess(parent)) continue;
    let tasks;
    try { tasks = readdirSync(`/proc/${parent.pid}/task`); } catch { continue; }
    for (const task of tasks) {
      let children;
      try { children = readFileSync(`/proc/${parent.pid}/task/${task}/children`, "utf8").trim().split(/\s+/); } catch { continue; }
      for (const value of children) {
        const pid = Number(value);
        if (!Number.isSafeInteger(pid) || pid <= 1 || seen.has(pid)) continue;
        seen.add(pid);
        try {
          const child = identity(pid);
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
          if (ppid !== parent.pid || child.uid !== leader.uid || !matchesProcess(parent) || !matchesProcess(child)) continue;
          queue.push(child);
          if (child.pgid === leader.pgid && child.session === leader.session) targets.push(child);
        } catch { /* child exited while taking the ownership snapshot */ }
      }
    }
  }
  return targets.reverse(); // children first; the leader can reap normal exits
}

async function stopOwned(file, role) {
  const first = processOwnership(file, role);
  if (first.status === "absent" || first.status === "dead") return;
  if (first.status !== "owned") throw new Error("unverified process ownership; refusing signal");
  const record = first.record;
  const targets = shutdownTargets(record);
  const checkOwnership = async () => {
    for (let attempt = 0; ; attempt++) {
      const fresh = processOwnership(file, role);
      // Linux may clear argv/environ while an exiting process is briefly
      // still visible as running. Do not signal through an uncertain read;
      // let that transition settle, then require verified ownership or death.
      if (fresh.status === "unverified" && attempt < 2) {
        await new Promise(r => setTimeout(r, 10));
        continue;
      }
      if (fresh.status === "unverified" || (fresh.status === "owned" && !same(fresh.record, record))) throw new Error("process identity changed during shutdown; refusing escalation");
      return;
    }
  };
  const signal = async (target, sig) => {
    await checkOwnership();
    // No negative-PGID signals: even after the leader exits, only a captured
    // child's independently matching start identity can authorize escalation.
    if (!matchesProcess(target)) return;
    try { process.kill(target.pid, sig); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  for (const target of targets) await signal(target, "SIGTERM");
  for (let i = 0; i < 20; i++) {
    await checkOwnership();
    if (!targets.some(matchesProcess)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await checkOwnership();
  for (const target of targets) await signal(target, "SIGKILL");
  removeProcessIdentity(file, record);
}

// Publish launch ownership BEFORE any application imports or initialization.
// The service PID remains a readiness record; launch ownership is separate.
async function launch(file, role, args) {
  if (!scripts[role] || !process.env.DEVIN_WEB_LAUNCH_ID) throw new Error("invalid managed launch");
  const record = writeProcessIdentity(`${file}.launch`, role, process.env, args);
  process.on("exit", () => removeProcessIdentity(`${file}.launch`, record));
  const script = join(ROOT, "bin", scripts[role]);
  process.argv = [process.execPath, script, ...args];
  await import(pathToFileURL(script).href);
}

async function cleanupLaunch(file, role, token) {
  if (!token) throw new Error("missing launch ownership token");
  for (const target of [`${file}.launch`, file]) {
    const own = processOwnership(target, role);
    if (own.status === "owned" && own.record.launchId === token) {
      const main = processOwnership(file, role);
      await stopOwned(target, role);
      if (main.status === "owned" && main.record.launchId === token) removeProcessIdentity(file, main.record);
      return;
    }
  }
  // Never infer ownership from a captured/reused PID or changed launch file.
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, file, role, ...args] = process.argv.slice(2);
  try {
    if (command === "token") console.log(randomUUID());
    else if (command === "launch") {
      // Finish evaluating this library before the application imports it back.
      void launch(file, role, args).catch(error => { console.error(`process-identity: ${error.message}`); process.exitCode = 1; });
    }
    else if (command === "cleanup") await cleanupLaunch(file, role, args[0]);
    else if (command === "adopt") adoptProcessIdentity(file, role);
    else if (command === "stop") await stopOwned(file, role);
    else {
      const result = processOwnership(file, role);
      if (command === "alive") process.exitCode = result.status === "owned" ? 0 : 1;
      else if (command === "guard") {
        const pending = processOwnership(`${file}.launch`, role);
        if (result.status === "unverified" || pending.status === "unverified") throw new Error(`unverified process ownership at ${file}; inspect and explicitly adopt a legitimate legacy process with process-identity.mjs adopt (port/config must match)`);
        if (pending.status === "owned" && result.status !== "owned") throw new Error(`process initializing at ${file}; launch already in progress`);
        if (pending.status === "owned" && result.status === "owned" && (pending.record.pid !== result.record.pid || pending.record.launchId !== result.record.launchId)) throw new Error(`conflicting process ownership at ${file}`);
      } else throw new Error("unknown process identity command");
    }
  } catch (error) { console.error(`process-identity: ${error.message}`); process.exitCode = 1; }
}
