#!/usr/bin/env node
// `just accept-gui [--keep]` — the M4 acceptance matrix, run against the REAL
// GUI (build product) and a REAL daemon, on a copy of the nest.
//
// The phase order below IS the contract (M4 T6):
//
//   1. the recipe builds everything and makes the 30-minute fixture on the
//      NODE abi, because `backup-nest` loads better-sqlite3;
//   2. this script copies the nest while nothing is running;
//   3. only then does it switch better-sqlite3 to the ELECTRON abi;
//   4. the acceptance daemon is started by running `testing/boot-child`
//      through the Electron binary with ELECTRON_RUN_AS_NODE — a system
//      `node` would load the wrong ABI — and it must own port 47100 before
//      the GUI appears, so the GUI takes its "reuse, never adopt" path;
//   5. the GUI starts last, in preview mode, so criterion 5 sees the
//      production CSP rather than the dev one.
//
// Everything is torn down in a finally, and the copy is deleted unless
// `--keep` was passed.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupNest } from '../packages/core/dist/index.js';

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DAEMON_URL = 'http://127.0.0.1:47100';
const CDP_PORT = 9333;
/**
 * ~192 KiB/s: fast enough to read an MP4's index, slow enough that a
 * 30-minute file can never buffer ahead of a seek (it would need six minutes
 * of transfer to reach the 90% mark this suite seeks to).
 *
 * It was 48 KiB/s while the library held mp3, which has no index at all and
 * starts playing on the first frames. Canonical m4a (0.3.0) must read `moov`
 * before it can report a duration, and for half an hour of AAC that is a few
 * hundred KB — at 48 KiB/s every load took ten seconds and the suite was
 * measuring dial-up, not the product.
 */
const AUDIO_THROTTLE_BPS = 192 * 1024;
const FIXTURE = join(ROOT, 'spikes/media-protocol/fixtures/fixture.mp3');

const keep = process.argv.includes('--keep');
const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function runRecipe(recipe) {
  const res = spawnSync('just', [recipe], { stdio: 'inherit', cwd: ROOT });
  if (res.status !== 0) throw new Error(`just ${recipe} failed (${res.status})`);
}

// ── daemon control ─────────────────────────────────────

function startDaemon(nestDir) {
  const electron = require('electron');
  const child = spawn(electron, [join(ROOT, 'packages/daemon/dist/testing/boot-child.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      LARK_NEST_DIR: nestDir,
      LARK_DAEMON_TEST_PORT: '47100',
      LARK_ACCEPT_AUDIO_THROTTLE_BPS: String(AUDIO_THROTTLE_BPS),
      LARK_ACCEPT_DEBUG_ROUTES: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[daemon] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[daemon] ${chunk}`));
  return child;
}

async function waitForDaemon(nestDir, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await fetch(`${DAEMON_URL}/status`, { signal: AbortSignal.timeout(1000) });
      if (status.ok) {
        const token = (await readFile(join(nestDir, 'lark/daemon-token'), 'utf8')).trim();
        const instance = await fetch(`${DAEMON_URL}/api/instance`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(1000),
        });
        if (instance.ok) return { token, instance: (await instance.json()).data };
      }
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error('the acceptance daemon never became ready');
}

async function stopChild(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const started = Date.now();
  while (child.exitCode === null && Date.now() - started < timeoutMs) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

// ── CDP ────────────────────────────────────────────────

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
 * The daemon's own `audio range` debug lines, read out of the copy's log.
 * This is what makes "the seek produced a NEW request" observable without
 * adding surface to the daemon.
 */
async function audioLog(nestDir) {
  const dir = join(nestDir, 'lark/logs');
  let raw = '';
  try {
    // pino-roll writes `lark.log.1`, `lark.log.2`, … — never a bare
    // `lark.log`, even though that is the path the daemon prints.
    const files = (await readdir(dir)).filter((name) => name.startsWith('lark.log')).sort();
    for (const name of files) raw += await readFile(join(dir, name), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.includes('"msg":"audio range"'))
    .map((line) => JSON.parse(line));
}

/** Force debug logging in the COPY so those lines exist. */
function enableDebugLog(larkDir) {
  const path = join(larkDir, 'lark_config.toml');
  const current = readFileSync(path, 'utf8');
  const next = current.includes('[log]')
    ? current.replace(/\[log\][\s\S]*?(?=\n\[|$)/, '[log]\nlevel = "debug"\n')
    : `${current}\n[log]\nlevel = "debug"\n`;
  writeFileSync(path, next, { mode: 0o600 });
}

// ── the run ────────────────────────────────────────────

let daemon = null;
let gui = null;
let copy = null;
let cdp = null;

try {
  console.log('[1/6] copying the nest (node abi)…');
  copy = await backupNest();
  console.log(`      ${copy.nestDir}`);
  enableDebugLog(copy.larkDir);

  console.log('[2/6] switching better-sqlite3 to the electron abi…');
  runRecipe('ensure-electron-abi');

  console.log('[3/6] starting the acceptance daemon on 47100…');
  daemon = startDaemon(copy.nestDir);
  const { token, instance } = await waitForDaemon(copy.nestDir);
  check(
    'the acceptance daemon owns 47100 and names the copy',
    instance.nest_dir === copy.larkDir,
    instance.nest_dir,
  );

  const auth = { Authorization: `Bearer ${token}` };
  const api = async (method, path, body) => {
    const res = await fetch(`${DAEMON_URL}${path}`, {
      method,
      headers: body ? { ...auth, 'Content-Type': 'application/json' } : auth,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
  };

  console.log('[4/6] importing the 30-minute fixture…');
  const imported = await api('POST', '/songs/import', { file_paths: [FIXTURE] });
  const fixtureId =
    imported.json?.data?.imported?.[0]?.song_id ??
    (await api('GET', '/songs?search=fixture')).json?.data?.[0]?.id;
  check(
    'the long fixture is in the copy library',
    typeof fixtureId === 'string',
    String(fixtureId),
  );

  // Criterion 3, first half: a media element never emits a malformed Range,
  // so 416 is asserted over plain HTTP (M4 T6).
  const bad = await fetch(`${DAEMON_URL}/audio/${fixtureId}`, {
    headers: { ...auth, Range: 'bytes=abc-def' },
  });
  const contentRange = bad.headers.get('content-range') ?? '';
  check(
    '3 · a malformed Range is 416 carrying the total size',
    bad.status === 416 && /^bytes \*\/\d+$/.test(contentRange),
    `${bad.status} ${contentRange}`,
  );
  const beyond = await fetch(`${DAEMON_URL}/audio/${fixtureId}`, {
    headers: { ...auth, Range: 'bytes=999999999-' },
  });
  check('3 · an unsatisfiable Range is 416 too', beyond.status === 416, String(beyond.status));
  const size = Number(/\/(\d+)$/.exec(contentRange)?.[1] ?? 0);

  console.log('[5/6] starting the GUI (preview build)…');
  // The built app, run straight through the Electron binary: `electron-vite
  // preview` is the same thing minus a way to pass --remote-debugging-port.
  gui = spawn(
    require('electron'),
    [join(ROOT, 'packages/gui'), `--remote-debugging-port=${CDP_PORT}`],
    {
      cwd: ROOT,
      env: { ...process.env, LARK_NEST_DIR: copy.nestDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  gui.stdout.on('data', (chunk) => process.stdout.write(`[gui] ${chunk}`));
  gui.stderr.on('data', (chunk) => process.stderr.write(`[gui] ${chunk}`));
  cdp = await attachCdp();
  await sleep(2500);

  const audioState = `(() => {
    const el = document.querySelector('audio');
    return el && {
      src: el.src,
      paused: el.paused,
      time: el.currentTime,
      duration: el.duration,
      error: el.error ? el.error.code : null,
    };
  })()`;

  const statusPid = (await api('GET', '/status')).json.data.pid;
  check(
    'the GUI reused the running daemon instead of spawning one',
    statusPid === daemon.pid,
    `status pid ${statusPid}, harness child ${daemon.pid}`,
  );

  // ── 1 · protocol registration ──
  await api('POST', '/player/play', { song_id: fixtureId });
  await sleep(4000);
  const playing = await cdp.evaluate(audioState);
  check(
    '1 · lark-media:// plays and reports the real duration',
    playing.src.startsWith('lark-media://song/') &&
      playing.paused === false &&
      Math.abs(playing.duration - 1800) < 5 &&
      playing.time > 0.5,
    `t=${playing.time.toFixed(1)} dur=${playing.duration?.toFixed(1)}`,
  );

  // ── 2 · Range pass-through, and 3's 206 half ──
  const before = (await audioLog(copy.nestDir)).length;
  await api('POST', '/player/seek', { position: 1620 }); // 90 %
  await sleep(4000);
  const fresh = (await audioLog(copy.nestDir)).slice(before);
  const ranged = fresh.filter((line) => typeof line.range === 'string' && line.range !== '');
  const start = ranged.length > 0 ? Number(/bytes=(\d+)-/.exec(ranged.at(-1).range)?.[1] ?? 0) : 0;
  check(
    '2 · the seek produced a new request at ~90 % of the file',
    ranged.length > 0 && size > 0 && Math.abs(start / size - 0.9) < 0.08,
    `${ranged.length} new requests, last at ${((start / size) * 100).toFixed(1)}%`,
  );
  check(
    '3 · every ranged response was 206',
    ranged.length > 0 && ranged.every((line) => line.status === 206),
    ranged.map((line) => line.status).join(','),
  );

  // ── 4 · seek storm ──
  for (let i = 0; i < 12; i++) {
    await api('POST', '/player/seek', { position: 60 + i * 97 });
    await sleep(150);
  }
  await sleep(4000);
  const stormState = await cdp.evaluate(audioState);
  const open = (await api('GET', '/debug/audio-streams')).json.data.open_audio_streams;
  check(
    '4 · a seek storm leaves no error state and a bounded stream count',
    stormState.error === null && open <= 12,
    `error=${stormState.error ?? 'none'} open=${open}`,
  );

  // ── 5 · production CSP + no token in the page ──
  const tokenInDom = await cdp.evaluate(
    `document.documentElement.outerHTML.includes(${JSON.stringify(token)}) || document.documentElement.outerHTML.includes('Bearer')`,
  );
  const violations = cdp.consoleErrors.filter(
    (text) => text.includes('Content Security Policy') || text.includes('Refused to'),
  );
  check(
    '5 · no CSP violation in the production build',
    violations.length === 0,
    violations.join(' | '),
  );
  check('5 · the token never reaches the DOM', tokenInDom === false);

  // ── 6 · token rotation across a daemon restart ──
  const positionBefore = (await cdp.evaluate(audioState)).time;
  await stopChild(daemon);
  await sleep(1500);
  daemon = startDaemon(copy.nestDir);
  const rotated = await waitForDaemon(copy.nestDir);
  check('6 · the restart rotated the token', rotated.token !== token);

  await sleep(9000);
  const recovered = await cdp.evaluate(audioState);
  check(
    '6 · playback survived the restart without a reload',
    recovered.error === null,
    `t=${recovered.time?.toFixed(1)} (was ${positionBefore.toFixed(1)}) paused=${recovered.paused}`,
  );
  const newAuth = { Authorization: `Bearer ${rotated.token}` };
  const seekAfter = await fetch(`${DAEMON_URL}/player/seek`, {
    method: 'POST',
    headers: { ...newAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ position: 900 }),
  });
  await sleep(3000);
  const afterSeek = await cdp.evaluate(audioState);
  check(
    '6 · a seek after the restart is served on the new generation',
    seekAfter.status === 200 && Math.abs(afterSeek.time - 900) < 30,
    `${seekAfter.status} t=${afterSeek.time?.toFixed(1)}`,
  );

  // ── what T4 could not reach: a quit GUI answers 409 ──
  console.log('[6/6] quitting the GUI…');
  cdp.close();
  cdp = null;
  await stopChild(gui, 8000);
  await sleep(1500);
  const offline = await fetch(`${DAEMON_URL}/player/pause`, { method: 'POST', headers: newAuth });
  const offlineBody = await offline.json().catch(() => null);
  check(
    'a player command with no GUI attached is 409 GUI_OFFLINE',
    offline.status === 409 && offlineBody?.error_code === 'GUI_OFFLINE',
    `${offline.status} ${offlineBody?.error_code}`,
  );
} finally {
  if (cdp) cdp.close();
  await stopChild(gui, 8000);
  await stopChild(daemon);
  if (copy) {
    if (keep) console.log(`\ncopy kept at ${copy.nestDir}`);
    else rmSync(copy.nestDir, { recursive: true, force: true });
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
