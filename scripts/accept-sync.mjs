#!/usr/bin/env node
// `just accept-sync [--keep] [--skip-e2e]` — the v0.2 acceptance matrix (plan
// §6), run against a REAL skybridge server, two REAL daemons on two separate
// nests, the REAL `lark` binary and the REAL GUI.
//
// Two devices is the whole point: every invariant sync has is about what two
// installs do to one workspace, and a single library talking to a server can
// only ever demonstrate that push and pull are wired up. So device A is a copy
// of the actual library driven through the CLI, and device B is a second
// daemon on its own nest driven over HTTP — the shape a second machine has,
// minus the network.
//
// Phase order is the contract, for the same reason accept-gui's is:
//
//   1. the e2e suites and the static registry checks first — they are cheap
//      and they fail loudly;
//   2. the CLI phases run on the NODE abi, because `backupNest`, `lark
//      --direct` and both daemons load better-sqlite3 through plain node;
//   3. the GUI phase switches to the ELECTRON abi and restarts device A's
//      daemon through the Electron binary, exactly like accept-gui;
//   4. the abi goes back to node at the end, because `sync unbind` is a direct
//      write and has to run after everything else has stopped.
//
// Left to a person (docs/plans/2026-08-12-v0.2-soak-checklist.md): anything
// that needs a real network — the cloud server over plaintext http with the
// breaker flipped, a token refresh that actually ages, a laptop that sleeps.

import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupNest } from '../packages/core/dist/index.js';
import { waitForLibraryReady } from './lib/library-ready.mjs';

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'apps/cli/dist/index.js');
const BOOT_CHILD = join(ROOT, 'packages/daemon/dist/testing/boot-child.js');
const DAEMON_A = 'http://127.0.0.1:47100';
const PORT_B = 47101;
const DAEMON_B = `http://127.0.0.1:${PORT_B}`;
const CDP_PORT = 9334;

/** Distinctive on purpose: the log-hygiene check greps for these verbatim. */
const EMAIL = 'accept-sync@lark.test';
const PASSWORD = 'pw-accept-sync-9f3c1d7e-never-log-me';
/** A source key shaped like a real one — core rejects anything else (M5). */
const DUPLICATE_KEY = 'BV1GJ411x7h7:987654321';

const keep = process.argv.includes('--keep');
const skipE2e = process.argv.includes('--skip-e2e');
const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ─── Driving the CLI ───────────────────────────────────

function parse(text) {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

/** The last line that parses as JSON — see `codeOf`. */
function parseLast(text) {
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parse(lines[i]);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Run `lark <args>` against a nest, and report everything it produced. */
function lark(args, nest, options = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, LARK_NEST_DIR: nest },
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeoutMs ?? 120_000,
  });
  const out = res.stdout ?? '';
  const err = res.stderr ?? '';
  return { code: res.status, out, err, json: parse(out), errJson: parseLast(err) };
}

/**
 * The error code the CLI reported, whichever mode it was in.
 *
 * The envelope is the LAST line of stderr, not all of it: `sync unbind` names
 * what it is about to throw away on stderr before it fails, so parsing the
 * whole stream finds no JSON at all.
 */
const codeOf = (res) =>
  res.errJson?.error_code ?? /\(([A-Z_]+)\)\s*$/.exec(res.err.trim())?.[1] ?? null;

/** `lark sync login`, with the password on stdin — there is no flag for it. */
function login(nest) {
  return lark(
    ['--json', 'sync', 'login', '--server', server.baseUrl, '--email', EMAIL, '--password-stdin'],
    nest,
    { input: `${PASSWORD}\n` },
  );
}

/**
 * A login attempt at some other URL — the transport gate's material.
 *
 * `--yes` is a GLOBAL flag and `--allow-insecure-http` belongs to the
 * subcommand, so they sit on opposite sides of `sync login`. Putting the
 * subcommand's flag up front makes commander refuse the whole invocation with
 * its own exit 1, which looks exactly like the refusal being tested.
 */
function loginAt(url, nest, { insecure = false, yes = false } = {}) {
  return lark(
    [
      '--json',
      ...(yes ? ['--yes'] : []),
      'sync',
      'login',
      '--server',
      url,
      '--email',
      EMAIL,
      '--password-stdin',
      ...(insecure ? ['--allow-insecure-http'] : []),
    ],
    nest,
    { input: `${PASSWORD}\n` },
  );
}

// ─── Driving a daemon over HTTP ────────────────────────

function apiFor(baseUrl, larkDir) {
  // Re-read every call: a restarted daemon rotates the token (M4).
  const token = () => readFileSync(join(larkDir, 'daemon-token'), 'utf8').trim();
  return async (method, path, body) => {
    const headers = { Authorization: `Bearer ${token()}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
}

/**
 * The songs the outbox already carries a `create` for.
 *
 * A READ-ONLY open, which takes no lock (M6) while both daemons hold the file;
 * opened and closed per question because login is what changes the answer.
 */
function songsWithCreateChange(larkDir) {
  const db = require('better-sqlite3')(join(larkDir, 'songs.db'), { readonly: true });
  try {
    const rows = db
      .prepare("SELECT entity_id FROM sync_changes WHERE entity_type = 'song' AND op = 'create'")
      .all();
    return new Set(rows.map((row) => row.entity_id));
  } finally {
    db.close();
  }
}

async function daemonIsUp(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForDaemon(baseUrl, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await daemonIsUp(baseUrl)) {
      // Device A runs on a copy of the real nest, which may still be at schema
      // v2 — answering is not the same as serving (0.3.0 §3.2-3).
      await waitForLibraryReady(baseUrl, { log: (line) => console.log(line) });
      return true;
    }
    await sleep(300);
  }
  throw new Error(`no daemon answered on ${baseUrl}`);
}

async function waitForDaemonGone(baseUrl, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await daemonIsUp(baseUrl))) return true;
    await sleep(200);
  }
  return false;
}

async function stopChild(child, timeoutMs = 8000) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const started = Date.now();
  while (child.exitCode === null && Date.now() - started < timeoutMs) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

// ─── The skybridge server ──────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Where the server lives, in the same order the e2e suites look.
 *
 * `@orpheus-aviary/skybridge-server` is published, but lark does not depend on
 * it — nothing in the app ever talks to a server in-process. So it is resolved
 * at run time, and its absence is a HARD failure here (unlike the e2e suites,
 * which skip): an acceptance run that quietly tested nothing is worse than one
 * that says it cannot run.
 */
function resolveSkybridgeBin() {
  const candidates = [
    process.env.LARK_SKYBRIDGE_SERVER_BIN,
    join(ROOT, '../skybridge/packages/server/dist/bin/skybridge-server.js'),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '' && existsSync(candidate)) return candidate;
  }
  try {
    const manifest = require.resolve('@orpheus-aviary/skybridge-server/package.json');
    const installed = join(dirname(manifest), 'bin/skybridge-server.js');
    if (existsSync(installed)) return installed;
  } catch {
    // Not installed: the two candidates above were the real chances.
  }
  return null;
}

async function startSkybridge() {
  const bin = resolveSkybridgeBin();
  if (bin === null) {
    throw new Error(
      'no skybridge server found — build the sibling checkout, install ' +
        '@orpheus-aviary/skybridge-server, or point LARK_SKYBRIDGE_SERVER_BIN at its bin',
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'lark-accept-sync-server-'));
  const port = await freePort();
  const config = join(dir, 'server.toml');
  writeFileSync(
    config,
    [
      '[server]',
      'host = "127.0.0.1"',
      `port = ${port}`,
      '',
      '[storage]',
      `db_path = "${join(dir, 'skybridge.db')}"`,
      `attachment_root = "${join(dir, 'attachments')}"`,
      '',
      '[logging]',
      'level = "error"',
      '',
    ].join('\n'),
  );

  const serverCli = (args) => {
    const res = spawnSync(process.execPath, [bin, '--config', config, ...args], {
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(`skybridge-server ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
    }
    return res.stdout;
  };
  serverCli(['--init']);
  serverCli(['user', 'create', '--email', EMAIL, '--password', PASSWORD]);

  const child = spawn(process.execPath, [bin, '--config', config], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[skybridge] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[skybridge] ${chunk}`));

  const baseUrl = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      const res = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return { baseUrl, child, dir, bin, config };
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error('the skybridge server never became healthy');
}

// ─── CDP (the same shape accept-gui uses) ──────────────

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const waiters = new Map();
  const consoleErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiters.has(msg.id)) {
      const waiter = waiters.get(msg.id);
      waiters.delete(msg.id);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
      return;
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(msg.params.entry.text);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiters.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result.value;
  };
  await send('Runtime.enable');
  await send('Log.enable');
  return { send, evaluate, consoleErrors, close: () => ws.close() };
}

async function attachCdp() {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return await connect(page.webSocketDebuggerUrl);
    } catch {
      // devtools not listening yet
    }
    await sleep(500);
  }
  throw new Error('no renderer target appeared on the debugging port');
}

/**
 * A click Radix cannot ignore, plus an exact-text finder.
 *
 * T4c's smoke found both the hard way: Tabs activate on `mousedown`, so a bare
 * `.click()` does nothing, and matching button text with `includes` picks up
 * the checkbox label that happens to contain the same word.
 */
const CDP_HELPERS = `
  window.__accept_click = (el) => {
    if (!el) return false;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  };
  window.__accept_byText = (selector, text) =>
    [...document.querySelectorAll(selector)].find((el) => el.textContent.trim() === text) ?? null;
  true`;

// ─── Reading what the run left behind ──────────────────

/** Everything the daemon wrote, across pino-roll's numbered files. */
async function readLogs(nestDir) {
  const dir = join(nestDir, 'lark/logs');
  let raw = '';
  try {
    const names = (await readdir(dir)).filter((name) => name.startsWith('lark.log'));
    for (const name of names) raw += await readFile(join(dir, name), 'utf8');
  } catch {
    return '';
  }
  return raw;
}

/** Every file under a directory, at every depth. */
function walk(root) {
  const found = [];
  const step = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) step(full);
      else found.push(full);
    }
  };
  step(root);
  return found;
}

function runRecipe(recipe) {
  const res = spawnSync('just', [recipe], { stdio: 'inherit', cwd: ROOT });
  if (res.status !== 0) throw new Error(`just ${recipe} failed (${res.status})`);
}

// ─── The run ───────────────────────────────────────────

let server = null;
let copy = null;
let nestB = null;
let freshRoot = null;
let daemonB = null;
let daemonA = null;
let gui = null;
let cdp = null;
let electronAbi = false;

try {
  if (await daemonIsUp(DAEMON_A)) {
    throw new Error('something is already listening on 47100 — stop it before the acceptance run');
  }
  if (await daemonIsUp(DAEMON_B)) {
    throw new Error(`something is already listening on ${PORT_B}`);
  }

  // ── A · the suites and the registries ──

  if (skipE2e) {
    console.log('[1/9] skipping the e2e suites (--skip-e2e)');
  } else {
    console.log('[1/9] running both e2e suites…');
    const e2e = spawnSync('just', ['test-sync-e2e'], { cwd: ROOT, encoding: 'utf8' });
    const summary = /Tests\s+([^\n]*)/.exec(e2e.stdout ?? '')?.[1]?.trim() ?? '';
    if (e2e.status !== 0) process.stderr.write(`${e2e.stdout}\n${e2e.stderr}\n`);
    check(
      'A1 · both sync e2e suites are green (19 cases: dual 15 + files 4)',
      e2e.status === 0 && /19 passed/.test(summary),
      summary || `exit ${e2e.status}`,
    );
  }

  console.log('[2/9] error-code registries…');
  const { DAEMON_ENVELOPE_ERROR_CODES } = await import('../packages/shared/dist/index.js');
  const { statusForCode } = await import('../packages/daemon/dist/error-mapping.js');
  const { EXIT_MAP } = await import('../apps/cli/dist/lib/exit-codes.js');
  const SYNC_CODES = [
    'SYNC_BINDING_MISMATCH',
    'SYNC_SCHEMA_VERSION_MISMATCH',
    'SYNC_INSECURE_URL',
    'SYNC_AUTH_REQUIRED',
    'SYNC_UNAVAILABLE',
    'SYNC_PENDING_CHANGES',
    'CONFLICT_NOT_FOUND',
    'CONFLICT_VERSION_MISMATCH',
    'AMBIGUOUS_SOURCE_KEY',
    'FILE_OP_NOT_FOUND',
    'FILE_OP_BUSY',
  ];
  const missing = SYNC_CODES.filter(
    (code) =>
      !DAEMON_ENVELOPE_ERROR_CODES.includes(code) ||
      typeof statusForCode(code) !== 'number' ||
      EXIT_MAP[code] === undefined,
  );
  check(
    'A2 · the 11 sync codes are in the shared registry, the status table and EXIT_MAP',
    missing.length === 0,
    missing.length === 0 ? `${SYNC_CODES.length} codes` : `missing: ${missing.join(', ')}`,
  );
  const orphans = DAEMON_ENVELOPE_ERROR_CODES.filter(
    (code) => typeof statusForCode(code) !== 'number' || EXIT_MAP[code] === undefined,
  );
  check(
    'A3 · no envelope code anywhere is missing a status or an exit code',
    orphans.length === 0,
    orphans.length === 0
      ? `${DAEMON_ENVELOPE_ERROR_CODES.length} codes mapped`
      : `orphans: ${orphans.join(', ')}`,
  );

  // ── the fixtures ──

  console.log('[3/9] starting a real skybridge server…');
  server = await startSkybridge();
  console.log(`      ${server.baseUrl}`);

  console.log('      copying the nest (device A)…');
  copy = await backupNest();
  const nestA = copy.nestDir;
  const larkA = copy.larkDir;
  console.log(`      ${nestA}`);
  // A v1 library refuses to migrate on a read-only open (zero writes, by
  // design), so the copy is brought forward the way a user does it: one daemon
  // start. Without this every `--direct` path below is MIGRATION_PENDING.
  lark(['daemon'], nestA);
  lark(['stop-daemon'], nestA);
  await waitForDaemonGone(DAEMON_A);

  // Both of these are `<mkdtemp>/nest`, and the FINALLY removes the mkdtemp
  // parent — a harness that leaks one temp directory per run is the M5 lesson
  // repeating itself (237 of them accumulated last time before anyone noticed).
  freshRoot = mkdtempSync(join(tmpdir(), 'lark-accept-sync-fresh-'));
  const freshNest = join(freshRoot, 'nest');
  nestB = join(mkdtempSync(join(tmpdir(), 'lark-accept-sync-b-')), 'nest');
  const larkB = join(nestB, 'lark');

  console.log('      starting device A through `lark daemon`…');
  lark(['daemon'], nestA);
  await waitForDaemon(DAEMON_A);
  const apiA = apiFor(DAEMON_A, larkA);
  const credentialsA = join(larkA, 'skybridge.toml');

  // ── C · the transport gate ──

  console.log('[4/9] the HTTPS gate…');

  const insecure = loginAt('http://sync.example.test:8443', nestA);
  check(
    'C1 · plaintext http to a non-loopback host is refused before anything is sent',
    insecure.code === 2 && codeOf(insecure) === 'SYNC_INSECURE_URL',
    `${insecure.code} ${codeOf(insecure)}`,
  );

  const wrongScheme = loginAt('ftp://sync.example.test', nestA);
  check(
    'C2 · a scheme that is neither http nor https fails closed',
    wrongScheme.code === 2 && codeOf(wrongScheme) === 'SYNC_INSECURE_URL',
    `${wrongScheme.code} ${codeOf(wrongScheme)}`,
  );

  const closedPort = await freePort();
  const noConfirm = loginAt(`http://127.0.0.1:${closedPort}`, nestA, { insecure: true });
  check(
    'C3 · the breaker needs its second act: the flag without --yes sends nothing',
    noConfirm.code === 2 && codeOf(noConfirm) === 'USAGE_ERROR' && !existsSync(credentialsA),
    `${noConfirm.code} ${codeOf(noConfirm)}, credentials ${existsSync(credentialsA)}`,
  );

  const confirmed = loginAt(`http://127.0.0.1:${closedPort}`, nestA, {
    insecure: true,
    yes: true,
  });
  check(
    'C4 · with both acts it really tries, and an unreachable server is SYNC_UNAVAILABLE',
    confirmed.code === 1 && codeOf(confirmed) === 'SYNC_UNAVAILABLE',
    `${confirmed.code} ${codeOf(confirmed)}`,
  );

  const httpsDown = loginAt(`https://127.0.0.1:${closedPort}`, nestA);
  check(
    'C5 · an https URL nobody answers is a transport failure, not a gate failure',
    httpsDown.code === 1 && codeOf(httpsDown) === 'SYNC_UNAVAILABLE',
    `${httpsDown.code} ${codeOf(httpsDown)}`,
  );

  // ── D · the eight commands, and B · what they must not leak ──

  console.log('[5/9] the CLI…');

  const statusBefore = lark(['--json', 'sync', 'status'], nestA);
  check(
    'D1 · status before a login says exactly what is missing',
    statusBefore.code === 0 &&
      statusBefore.json?.data?.state === 'auth_required' &&
      statusBefore.json?.data?.auth_reason === 'missing_session' &&
      statusBefore.json?.data?.bound === false,
    `${statusBefore.json?.data?.state}/${statusBefore.json?.data?.auth_reason}`,
  );

  const freshConfig = lark(['sync', 'config-show'], freshNest);
  check(
    'D2 · config-show works with no daemon and no library at all',
    freshConfig.code === 0 && freshConfig.out.includes('还没有配置同步'),
    `${freshConfig.code} ${freshConfig.out.trim().slice(0, 40)}`,
  );

  // Two imported songs of our own, seeded BEFORE the library is measured.
  // E5 needs a file that cannot be re-downloaded, and borrowing one from the
  // user's library made this suite a hostage of what they happen to own — the
  // day that library became seven downloaded songs, E5 stopped measuring
  // quarantine and started measuring their listening habits (accept-m5 §5's
  // lesson, arriving here one release later).
  const seeds = ['accept-sync-import-a.m4a', 'accept-sync-import-b.m4a'].map((name) =>
    join(nestA, name),
  );
  for (const path of seeds) copyFileSync(join(ROOT, 'scripts/fixtures/tone-1s.m4a'), path);
  const seeded = await apiA('POST', '/songs/import', { file_paths: seeds });
  if ((seeded.json?.data?.imported ?? []).length !== 2) {
    throw new Error(`the import seed failed: ${JSON.stringify(seeded.json)}`);
  }

  const songsBefore = lark(['--json', 'songs', 'list', '--limit', '500'], nestA).json?.data ?? [];
  // What the backfill actually owes: a song whose `create` is still sitting in
  // the outbox is already published — the first round pushes it. A copy of a
  // REAL library arrives with such rows (every write emits one, bound or not),
  // so "backfill.songs === every song" was only ever true of a library nobody
  // had used. What must hold is that no song is left without one.
  const publishedBefore = songsWithCreateChange(larkA);
  const unpublished = songsBefore.filter((song) => !publishedBefore.has(song.id)).length;
  const loggedIn = login(nestA);
  const loginData = loggedIn.json?.data;
  const publishedAfter = songsWithCreateChange(larkA);
  check(
    'D3 · login registers a device, binds a workspace and leaves no song unpublished',
    loggedIn.code === 0 &&
      typeof loginData?.device_id === 'string' &&
      typeof loginData?.workspace_id === 'string' &&
      loginData?.backfill?.songs === unpublished &&
      songsBefore.every((song) => publishedAfter.has(song.id)),
    `${loginData?.backfill?.songs}/${unpublished} owed of ${songsBefore.length} songs, device ${loginData?.device_reused ? 'reused' : 'new'}`,
  );

  const mode = statSync(credentialsA).mode & 0o777;
  check('B1 · the credential file is 0600', mode === 0o600, `0${mode.toString(8)}`);

  const ran = lark(['--json', 'sync', 'run'], nestA);
  const statusAfterRun = lark(['--json', 'sync', 'status'], nestA).json?.data;
  check(
    'D4 · one round leaves nothing pending and moves the pushed cursor',
    ran.code === 0 && statusAfterRun?.pending_count === 0 && statusAfterRun?.pushed_seq > 0,
    `pending ${statusAfterRun?.pending_count}, pushed_seq ${statusAfterRun?.pushed_seq}`,
  );

  const fileOps = lark(['sync', 'file-ops'], nestA);
  check(
    'D5 · file-ops with nothing owed says so, at exit 0',
    fileOps.code === 0 && fileOps.out.includes('没有排队或失败的文件操作'),
    `${fileOps.code}`,
  );

  const configShown = lark(['sync', 'config-show'], nestA);
  const configJson = lark(['--json', 'sync', 'config-show'], nestA).json?.data;
  const credentialsText = readFileSync(credentialsA, 'utf8');
  const accessToken = /^\s*token\s*=\s*"([^"]+)"/m.exec(credentialsText)?.[1] ?? '';
  const refreshToken = /^\s*refresh_token\s*=\s*"([^"]+)"/m.exec(credentialsText)?.[1] ?? '';
  check(
    'B2 · config-show renders the credentials without the credentials',
    configShown.code === 0 &&
      accessToken !== '' &&
      refreshToken !== '' &&
      !configShown.out.includes(accessToken) &&
      !configShown.out.includes(refreshToken) &&
      configJson?.has_token === true &&
      configJson?.token === undefined,
    `has_token ${configJson?.has_token}, token printed ${configShown.out.includes(accessToken)}`,
  );

  const unbindBlocked = lark(['--json', '--yes', 'sync', 'unbind'], nestA);
  check(
    'D6 · unbind refuses while the daemon owns the library',
    unbindBlocked.code === 5 && codeOf(unbindBlocked) === 'DAEMON_RUNNING_BLOCKED',
    `${unbindBlocked.code} ${codeOf(unbindBlocked)}`,
  );

  // ── E · two devices, one workspace ──

  console.log('[6/9] device B…');

  daemonB = spawn(process.execPath, [BOOT_CHILD], {
    cwd: ROOT,
    env: { ...process.env, LARK_NEST_DIR: nestB, LARK_DAEMON_TEST_PORT: String(PORT_B) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemonB.stdout.on('data', (chunk) => process.stdout.write(`[B] ${chunk}`));
  daemonB.stderr.on('data', (chunk) => process.stderr.write(`[B] ${chunk}`));
  await waitForDaemon(DAEMON_B);
  const apiB = apiFor(DAEMON_B, larkB);

  const loginB = await apiB('POST', '/sync/login', {
    server_url: server.baseUrl,
    email: EMAIL,
    password: PASSWORD,
  });
  await apiB('POST', '/sync/run');
  const songsOnB = (await apiB('GET', '/songs?limit=500')).json?.data ?? [];
  check(
    'E1 · a second device gets its own identity and the whole library',
    loginB.status === 200 &&
      loginB.json?.data?.device_id !== loginData?.device_id &&
      loginB.json?.data?.workspace_id === loginData?.workspace_id &&
      songsOnB.length === songsBefore.length,
    `${songsOnB.length}/${songsBefore.length} songs, device ${loginB.json?.data?.device_id?.slice(0, 8)}`,
  );

  const madeOnB = await apiB('POST', '/playlists', { name: 'B 建的歌单' });
  const playlistB = madeOnB.json?.data?.id;
  await apiB('POST', `/playlists/${playlistB}/songs`, { song_ids: [songsOnB[0].id] });
  await apiB('POST', '/sync/run');
  lark(['sync', 'run'], nestA);
  const playlistsOnA = lark(['--json', 'playlist', 'list'], nestA).json?.data ?? [];
  const arrived = playlistsOnA.find((p) => p.name === 'B 建的歌单');
  const arrivedSongs = arrived
    ? ((await apiA('GET', `/playlists/${arrived.id}/songs`)).json?.data ?? [])
    : [];
  check(
    'E2 · a playlist created on B arrives on A with its member',
    arrived !== undefined && arrivedSongs.length === 1 && arrivedSongs[0].id === songsOnB[0].id,
    `${arrived?.id ?? 'missing'} · ${arrivedSongs.length} member(s)`,
  );

  // The offline window: A is logged out, so its edits stay unpushed. That is
  // what makes a conflict possible at all (the pending gate, §4.6) and what
  // lets both devices claim one source key without either seeing the other.
  console.log('      the offline window (logout → both edit → login)…');
  // Four DISTINCT songs. The first pass reused one: the quarantine target was
  // also half of the duplicate pair, so deleting it on B dissolved the pair
  // before the GUI ever saw it, and F6 measured a fixture bug.
  const withFile = songsBefore.filter((s) => s.file_origin === 'imported' && s.has_file !== false);
  const conflictSong = withFile[0] ?? songsBefore[0];
  const taken = new Set([conflictSong.id]);
  const takeSong = (pool) => {
    const song = pool.find((s) => !taken.has(s.id));
    if (song !== undefined) taken.add(song.id);
    return song;
  };
  const quarantineTarget = takeSong(withFile) ?? null;
  const keySongA = takeSong(songsBefore);
  const keySongB = takeSong(songsBefore);

  const loggedOut = lark(['--json', 'sync', 'logout'], nestA);
  const loggedOutAgain = lark(['sync', 'logout'], nestA);
  check(
    'D7 · logout clears the session, keeps the binding, and is idempotent',
    loggedOut.code === 0 &&
      loggedOut.json?.data?.had_session === true &&
      loggedOutAgain.code === 0 &&
      loggedOutAgain.out.includes('本来就没有登录'),
    `${loggedOut.code}/${loggedOutAgain.code}`,
  );

  await apiA('PUT', `/songs/${conflictSong.id}`, { name: 'A 改的标题' });
  await apiA('PUT', `/songs/${keySongA.id}`, {
    source_url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    source_provider: 'bilibili',
    source_key: DUPLICATE_KEY,
  });

  // B edits the same song later — later is what makes it the winner — and
  // claims the same key on a song of its own.
  await sleep(50);
  await apiB('PUT', `/songs/${conflictSong.id}`, { name: 'B 改的标题' });
  await apiB('PUT', `/songs/${keySongB.id}`, {
    source_url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    source_provider: 'bilibili',
    source_key: DUPLICATE_KEY,
  });
  await apiB('POST', '/sync/run');

  const backIn = login(nestA);
  lark(['sync', 'run'], nestA);
  await sleep(800);
  await apiB('POST', '/sync/run');
  lark(['sync', 'run'], nestA);

  const conflictCount = (await apiA('GET', '/conflicts/count')).json?.data?.count ?? 0;
  const conflictList = (await apiA('GET', '/conflicts')).json?.data?.conflicts ?? [];
  const songOnA = (await apiA('GET', `/songs/${conflictSong.id}`)).json?.data;
  check(
    'E3 · the loser gets a receipt: one conflict, and the row holds the remote value',
    backIn.code === 0 &&
      conflictCount === 1 &&
      conflictList[0]?.entity_id === conflictSong.id &&
      conflictList[0]?.local_payload?.name === 'A 改的标题' &&
      songOnA?.name === 'B 改的标题',
    `${conflictCount} conflict(s), row now "${songOnA?.name}"`,
  );

  const statusDup = lark(['--json', 'sync', 'status'], nestA).json?.data;
  const duplicates = lark(['--json', 'songs', 'list', '--duplicates'], nestA);
  const duplicateIds = (duplicates.json?.data ?? []).map((s) => s.id).sort();
  check(
    'E4 · two devices may claim one source key, and both songs survive as duplicates',
    statusDup?.duplicate_source_keys === 2 &&
      duplicates.code === 0 &&
      JSON.stringify(duplicateIds) === JSON.stringify([keySongA.id, keySongB.id].sort()),
    `status ${statusDup?.duplicate_source_keys}, listed ${duplicateIds.length}`,
  );

  const narrowed = lark(['--json', 'songs', 'list', '--duplicates', '--search', '晴'], nestA);
  check(
    'D8 · --duplicates refuses every flag that would narrow the scan',
    narrowed.code === 2 && codeOf(narrowed) === 'USAGE_ERROR',
    `${narrowed.code} ${codeOf(narrowed)}`,
  );

  // A remote delete of a song whose bytes cannot be fetched again: they go to
  // recovered-songs/ rather than away (§3.6, R4-3).
  console.log('      remote delete → quarantine…');
  let quarantineOk = false;
  let quarantineDetail = 'no imported song with a file in the copy';
  if (quarantineTarget !== null) {
    await apiB('DELETE', `/songs/${quarantineTarget.id}`);
    await apiB('POST', '/sync/run');
    lark(['sync', 'run'], nestA);
    await sleep(1500);
    const statusQ = lark(['--json', 'sync', 'status'], nestA).json?.data;
    // The parked directory is `<song_id>-<op_uuid>`: stable per op, so a replay
    // lands in the same place.
    const recoveredRoot = join(larkA, 'recovered-songs');
    const parked = existsSync(recoveredRoot)
      ? readdirSync(recoveredRoot, { withFileTypes: true }).filter(
          (entry) => entry.isDirectory() && entry.name.startsWith(quarantineTarget.id),
        )
      : [];
    const gone = !existsSync(join(larkA, 'songs', quarantineTarget.id, 'song.m4a'));
    const bytes =
      parked.length === 1 && walk(join(larkA, 'recovered-songs', parked[0].name)).length > 0;
    quarantineOk = statusQ?.quarantined_count >= 1 && bytes && gone;
    quarantineDetail = `quarantined ${statusQ?.quarantined_count}, parked ${parked.map((p) => p.name).join(',') || 'none'}, original gone ${gone}`;
  }
  check(
    'E5 · a remote delete parks an unreplaceable file instead of deleting it',
    quarantineOk,
    quarantineDetail,
  );

  const logsA = await readLogs(nestA);
  const logsB = await readLogs(nestB);
  const leaked = [
    ['password', PASSWORD],
    ['access token', accessToken],
    ['refresh token', refreshToken],
  ].filter(([, secret]) => secret !== '' && (logsA.includes(secret) || logsB.includes(secret)));
  check(
    'B3 · neither daemon wrote the password or either token to its log',
    leaked.length === 0 && logsA.length > 0,
    leaked.length === 0
      ? `${logsA.length + logsB.length} bytes of log`
      : leaked.map(([name]) => name).join(', '),
  );

  // ── F · the window ──

  console.log('[7/9] switching to the electron abi and restarting device A…');
  lark(['stop-daemon'], nestA);
  await waitForDaemonGone(DAEMON_A);
  runRecipe('ensure-electron-abi');
  electronAbi = true;

  const electron = require('electron');
  daemonA = spawn(electron, [BOOT_CHILD], {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      LARK_NEST_DIR: nestA,
      LARK_DAEMON_TEST_PORT: '47100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemonA.stdout.on('data', (chunk) => process.stdout.write(`[A] ${chunk}`));
  daemonA.stderr.on('data', (chunk) => process.stderr.write(`[A] ${chunk}`));
  await waitForDaemon(DAEMON_A);

  console.log('[8/9] the GUI…');
  gui = spawn(electron, [join(ROOT, 'packages/gui'), `--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT,
    env: { ...process.env, LARK_NEST_DIR: nestA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gui.stdout.on('data', (chunk) => process.stdout.write(`[gui] ${chunk}`));
  gui.stderr.on('data', (chunk) => process.stderr.write(`[gui] ${chunk}`));
  cdp = await attachCdp();
  await sleep(3500);
  await cdp.evaluate(CDP_HELPERS);

  const badge = await cdp.evaluate(`(() => {
    const el = document.querySelector('button[aria-label^="同步："]');
    return el && { label: el.getAttribute('aria-label'), text: el.innerText.replace(/\\s+/g, ' ').trim() };
  })()`);
  check(
    'F1 · the badge reports a live, logged-in session',
    badge?.label === '同步：已同步',
    `${badge?.label} · "${badge?.text}"`,
  );
  check(
    'F2 · the attention count is the conflict, and only the conflict',
    /(^|\s)1$/.test(badge?.text ?? ''),
    `"${badge?.text}"`,
  );

  const popover = await cdp.evaluate(`(async () => {
    window.__accept_click(document.querySelector('button[aria-label^="同步："]'));
    await new Promise((r) => setTimeout(r, 800));
    const panel = document.querySelector('[data-radix-popper-content-wrapper]');
    return panel ? panel.innerText.replace(/\\s+/g, ' ') : null;
  })()`);
  check(
    'F3 · the popover explains the conflict, the quarantine and the duplicates, and offers the way in',
    typeof popover === 'string' &&
      popover.includes('有 1 处冲突等待处理') &&
      popover.includes('查看') &&
      popover.includes('待推送') &&
      popover.includes('已隔离 1 首歌') &&
      popover.includes('有 2 首歌与其他歌曲来源相同'),
    (popover ?? 'no popover').slice(0, 120),
  );

  const dialog = await cdp.evaluate(`(async () => {
    window.__accept_click(window.__accept_byText('button', '查看'));
    await new Promise((r) => setTimeout(r, 1000));
    const el = document.querySelector('[role="dialog"]');
    return el ? el.innerText.replace(/\\s+/g, ' ') : null;
  })()`);
  check(
    'F4 · the conflict dialog shows both versions of the field that differs',
    typeof dialog === 'string' && dialog.includes('A 改的标题') && dialog.includes('B 改的标题'),
    (dialog ?? 'no dialog').slice(0, 90),
  );

  // Resolved through the dialog, not the API: the CAS payload the GUI sends is
  // part of what is being accepted, and so is whether the badge notices.
  const clickedKeep = await cdp.evaluate(`(async () => {
    const ok = window.__accept_click(document.querySelector('button[aria-label^="保留本机版本"]'));
    await new Promise((r) => setTimeout(r, 1500));
    return ok;
  })()`);
  const countAfter = (await apiA('GET', '/conflicts/count')).json?.data?.count;
  const badgeAfter = await cdp.evaluate(`(() => {
    const el = document.querySelector('button[aria-label^="同步："]');
    return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null;
  })()`);
  // The attention count is its own element, and it has to be read as one.
  //
  // Reading the button's whole text instead ("does it still end in 1?") cannot
  // tell an unresolved conflict from the label `待同步 1` — which is what the
  // badge legitimately says for the second or two between this resolve
  // emitting its own change and the outbox trigger pushing it. That made this
  // criterion a coin flip on where the click landed in the 1s poll cycle, and
  // it failed twice for a resolve that had worked perfectly: count 0,
  // attention 0, label `待同步 1`.
  //
  // `null` when the button is missing, so a window that never rendered the
  // badge fails rather than reading as "nothing to attend to".
  const attentionAfter = await cdp.evaluate(`(() => {
    const button = document.querySelector('button[aria-label^="同步："]');
    if (button === null) return null;
    const badge = button.querySelector('span.bg-destructive');
    return badge === null ? 0 : Number(badge.textContent.trim());
  })()`);
  check(
    'F5 · "保留本机" resolves through the CAS and the count drops live, with no reload',
    clickedKeep === true && countAfter === 0 && attentionAfter === 0,
    `count ${countAfter} → attention ${attentionAfter}, badge "${badgeAfter}"`,
  );

  const listView = await cdp.evaluate(`(() => {
    const marks = [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && el.textContent.trim() === '[重复]');
    return {
      rows: document.querySelectorAll('[data-testid^="song-row-"]').length,
      marked: marks
        .map((el) => el.closest('[data-testid^="song-row-"]')?.dataset.testid?.slice('song-row-'.length))
        .filter(Boolean)
        .sort(),
    };
  })()`);
  check(
    'F6 · the two songs sharing a key are the two the list marks',
    JSON.stringify(listView?.marked) === JSON.stringify([keySongA.id, keySongB.id].sort()),
    `${listView?.rows} rows, ${listView?.marked.length} marked`,
  );

  check(
    'F7 · no console error and no CSP violation while sync drove the window',
    cdp.consoleErrors.length === 0,
    cdp.consoleErrors.slice(0, 2).join(' | '),
  );

  // The resolve republished A's value; both devices should land on it.
  await apiA('POST', '/sync/run');
  await apiB('POST', '/sync/run');
  await sleep(500);
  await apiA('POST', '/sync/run');
  const finalA = (await apiA('GET', `/songs/${conflictSong.id}`)).json?.data;
  const finalB = (await apiB('GET', `/songs/${conflictSong.id}`)).json?.data;
  check(
    'E6 · after the resolve both devices hold the version the user kept',
    finalA?.name === 'A 改的标题' && finalB?.name === 'A 改的标题',
    `A "${finalA?.name}" · B "${finalB?.name}"`,
  );

  // ── the last two, with everything stopped ──

  console.log('[9/9] backup and unbind…');
  cdp.close();
  cdp = null;
  await stopChild(gui);
  gui = null;
  await stopChild(daemonA);
  daemonA = null;
  await waitForDaemonGone(DAEMON_A);
  await stopChild(daemonB);
  daemonB = null;
  runRecipe('ensure-node-abi');
  electronAbi = false;

  // `backupNest` reads the nest from the environment, like every other core
  // path — so pointing it at the copy means setting the same variable a user
  // would. `paths` re-evaluates on every call, so this needs no reset dance.
  process.env.LARK_NEST_DIR = nestA;
  const backup = await backupNest();
  const backupFiles = walk(backup.nestDir).map((path) => path.slice(backup.nestDir.length));
  const credentialsInBackup = backupFiles.filter((path) => path.includes('skybridge.toml'));
  check(
    'B4 · a backup carries the library and never the credentials, at any depth',
    credentialsInBackup.length === 0 &&
      backupFiles.some((path) => path.endsWith('songs.db')) &&
      existsSync(credentialsA),
    `${backupFiles.length} files, ${credentialsInBackup.length} credential file(s)`,
  );
  rmSync(backup.nestDir, { recursive: true, force: true });

  lark(['--direct', 'playlist', 'create', '未推送的歌单'], nestA);
  const unbindRefused = lark(['--json', '--yes', 'sync', 'unbind'], nestA);
  const unbindForced = lark(['--json', '--yes', 'sync', 'unbind', '--force'], nestA);
  const afterUnbind = lark(['--json', 'sync', 'config-show'], nestA).json?.data;
  check(
    'D9 · unbind refuses to strand unpushed changes, and --force says how many it dropped',
    unbindRefused.code === 5 &&
      codeOf(unbindRefused) === 'SYNC_PENDING_CHANGES' &&
      unbindForced.code === 0 &&
      unbindForced.json?.data?.discarded_changes >= 1 &&
      unbindForced.json?.data?.had_credentials === true &&
      !existsSync(credentialsA) &&
      afterUnbind?.server_url === '',
    `${codeOf(unbindRefused)} → dropped ${unbindForced.json?.data?.discarded_changes}`,
  );
} finally {
  if (cdp) cdp.close();
  await stopChild(gui);
  await stopChild(daemonA);
  await stopChild(daemonB);
  if (server) await stopChild(server.child);
  if (electronAbi) {
    try {
      runRecipe('ensure-node-abi');
    } catch (err) {
      console.error(`could not restore the node abi: ${err.message}`);
    }
  }
  if (keep) {
    console.log(
      `\nkept: ${copy?.nestDir ?? '-'} · ${nestB ?? '-'} · ${freshRoot ?? '-'} · ${server?.dir ?? '-'}`,
    );
  } else {
    if (copy) rmSync(copy.nestDir, { recursive: true, force: true });
    if (nestB) rmSync(dirname(nestB), { recursive: true, force: true });
    if (freshRoot) rmSync(freshRoot, { recursive: true, force: true });
    if (server) rmSync(server.dir, { recursive: true, force: true });
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
