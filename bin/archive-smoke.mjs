#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const archive = resolve(process.argv[2] ?? '');
if (!archive.endsWith('.tar.gz') || !existsSync(archive)) throw new Error('Supply the source .tar.gz archive');
const scratch = mkdtempSync(join(tmpdir(), 'devin-web-archive-'));
const source = join(scratch, 'source');
const state = join(scratch, 'state');
for (const dir of ['source', 'state', 'home', 'data/cli', 'config', 'cache', 'tmp', 'project']) mkdirSync(join(scratch, dir), { recursive: true });
const port = process.env.ARCHIVE_SMOKE_PORT || '3210';
const env = {
  PATH: process.env.PATH, HOME: join(scratch, 'home'), SHELL: '/bin/bash', LANG: 'C.UTF-8',
  XDG_DATA_HOME: join(scratch, 'data'), XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
  XDG_STATE_HOME: state, TMPDIR: join(scratch, 'tmp'), NEXT_TELEMETRY_DISABLED: '1', CI: '1',
  DEVIN_WEB_STATE_DIR: state, DEVIN_CLI_DIR: join(scratch, 'data/cli'), DEVIN_WEB_PORT: port,
  DEVIN_WEB_DIST_DIR: '.next', DEVIN_WEB_ACPD: '1', DEVIN_WEB_ACPD_PIDFILE: join(state, 'acpd.pid'),
  DEVIN_WEB_ACP_SOCK: join(state, 'acp.sock'), DEVIN_WEB_HOST_SOCK: join(state, 'host.sock'),
  DEVIN_WEB_FS_ROOTS: scratch, DEVIN_WEB_DEVIN_CONFIG: join(scratch, 'config/devin.json'),
  DEVIN_WEB_DEVIN_BIN: join(scratch, 'fake-devin'), DEVIN_WEB_ACP_FALLBACK: '0',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
const run = (command, args) => execFileSync(command, args, { cwd: source, env, stdio: 'inherit', timeout: 600_000 });
const ctl = join(source, 'bin/devin-web-ctl');
let started = false;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  const pids = ['pid', 'acpd.pid', 'web-watch.pid', 'acpd-idle-restart.pid'].flatMap((file) => {
    try { const pid = Number(readFileSync(join(state, file), 'utf8')); return Number.isInteger(pid) && pid > 1 ? [pid] : []; } catch { return []; }
  });
  let stopError;
  if (started) {
    try { execFileSync(ctl, ['stop', '--all'], { cwd: source, env, stdio: 'inherit', timeout: 90_000 }); }
    catch (error) { stopError = error; }
  }
  const alive = pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  if (alive.length) throw new Error(`Archive smoke processes still live; preserve ${scratch} for cleanup: ${alive.join(', ')}`);
  rmSync(scratch, { recursive: true, force: true });
  cleaned = true;
  if (stopError) throw stopError;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  try { cleanup(); } catch (error) { console.error(error); }
  process.exit(signal === 'SIGINT' ? 130 : 143);
});
try {
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  if (entries.some((p) => p.startsWith('/') || p.split('/').some((part) => ['..', '.git', 'node_modules', '.next'].includes(part)))) throw new Error('Unexpected archive entry');
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', source]);
  if (!(statSync(ctl).mode & 0o111)) throw new Error('Control script executable bit missing');
  for (const forbidden of ['.git', 'node_modules', '.next']) if (existsSync(join(source, forbidden))) throw new Error(`Not a fresh archive: ${forbidden}`);
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(scratch, 'fake-devin'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(source, 'test/fixtures/fake-acp.mjs'))} \"$@\"\n`, { mode: 0o700 });
  run('pnpm', ['install', '--frozen-lockfile']);
  run('pnpm', ['build']);
  // Mark before start so partial startup is also cleaned using this isolated state.
  started = true;
  run(ctl, ['start']);
  const base = `http://127.0.0.1:${port}`;
  const get = async (path) => {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Archive smoke failed: ${path} ${response.status}`);
    return response;
  };
  await get('/'); await get('/api/health'); await get('/api/sessions');
  const response = await fetch(base + '/api/terminals', { method: 'POST', headers: { 'content-type': 'application/json', 'x-devin-web': '1' }, body: JSON.stringify({ cwd: join(scratch, 'project') }), signal: AbortSignal.timeout(15_000) });
  const terminal = await response.json();
  if (!response.ok || !terminal || typeof terminal !== 'object' || !('terminalId' in terminal) || typeof terminal.terminalId !== 'string') throw new Error('Archive installation could not create a real PTY');
  const deleted = await fetch(base + `/api/terminals/${terminal.terminalId}`, { method: 'DELETE', headers: { 'x-devin-web': '1' }, signal: AbortSignal.timeout(15_000) });
  if (!deleted.ok) throw new Error('Archive PTY cleanup failed');
  if (existsSync(join(source, '.git'))) throw new Error('Archive smoke must not create a Git repository');
  console.log('Archive install, production build, ctl start, HTTP and native PTY passed without .git.');
} finally {
  cleanup();
}
