#!/usr/bin/env node
/**
 * Anti-rot harness for the media spike. Owns the server lifecycle end to end
 * (spawn → wait ready → assert → stop), so no assertion can run against a
 * server someone else already stopped.
 *
 * Two layers:
 *   node harness.mjs          fast — small generated fixture, no throttle, no
 *                             ffmpeg, no display. Runs inside `just check`.
 *   node harness.mjs --full   full — real 30-minute fixture + throttle, plus
 *                             `electron main.mjs --smoke` against the live
 *                             server. Runs at acceptance / on protocol changes
 *                             / on every Electron upgrade.
 *
 * Every wait has a timeout and every child is killed in `finally` — a failed
 * assertion must never leave an orphan server holding port 47190.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER = join(SPIKE_DIR, 'server.mjs');
const MAIN = join(SPIKE_DIR, 'main.mjs');
const RUNTIME_DIR = join(SPIKE_DIR, '.runtime');
const FIXTURES_DIR = join(SPIKE_DIR, 'fixtures');
const TOKEN_PATH = join(RUNTIME_DIR, 'daemon-token');
const GENERATION_PATH = join(RUNTIME_DIR, 'generation');
const FAST_FIXTURE = join(FIXTURES_DIR, 'fast-fixture.bin');
const REAL_FIXTURE = join(FIXTURES_DIR, 'fixture.m4a');

const BASE = 'http://127.0.0.1:47190';
const SONG_ID = '9e107d9d-372b-4e39-a3ee-8b2f3d1c4a5b';
const FULL = process.argv.includes('--full');
const PUBLISH_DELAY_MS = 600;

const children = new Set();
let failures = 0;

function check(label, pass, detail) {
  console.log(
    `  ${pass ? '✓' : '✗'} ${label}${pass || detail === undefined ? '' : ` — ${detail}`}`,
  );
  if (!pass) failures += 1;
}

function fatal(message) {
  throw new Error(message);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(extraArgs) {
  const child = spawn(process.execPath, [SERVER, ...extraArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, out: '', err: '', exitCode: null };
  child.stdout.on('data', (d) => {
    state.out += d;
  });
  child.stderr.on('data', (d) => {
    state.err += d;
  });
  child.on('exit', (code) => {
    state.exitCode = code;
    children.delete(child);
  });
  children.add(child);
  return state;
}

async function waitFor(label, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  fatal(`timed out waiting for ${label}`);
}

async function stopServer(state) {
  if (state.exitCode !== null) return;
  state.child.kill('SIGINT');
  await waitFor('server exit', () => state.exitCode !== null, 5000);
}

function readGeneration() {
  return Number.parseInt(readFileSync(GENERATION_PATH, 'utf8').trim(), 10);
}

function ensureFastFixture() {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  if (!existsSync(FAST_FIXTURE)) {
    // Range / 416 / auth semantics are independent of the bytes, so the fast
    // layer needs no ffmpeg and no real audio.
    writeFileSync(FAST_FIXTURE, randomBytes(2 * 1024 * 1024));
  }
  return FAST_FIXTURE;
}

async function get(path, { range, token, expectBody = true } = {}) {
  const headers = {};
  if (range !== undefined) headers.Range = range;
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  let bytes = -1;
  if (expectBody) bytes = (await res.bytes()).length;
  else await res.body?.cancel();
  return { status: res.status, headers: res.headers, bytes };
}

/** The HTTP contract both layers assert. `expectBody` is off for the throttled fixture. */
async function assertHttpContract(token, size, { expectBody }) {
  console.log('— HTTP contract');

  const full = await get(`/audio/${SONG_ID}`, { token, expectBody });
  check('no Range → 200', full.status === 200, full.status);
  check('200 carries Content-Length', full.headers.get('content-length') === String(size));
  check('200 carries Accept-Ranges: bytes', full.headers.get('accept-ranges') === 'bytes');
  check('200 is audio/mp4', full.headers.get('content-type') === 'audio/mp4');
  check('200 is no-store', full.headers.get('cache-control') === 'no-store');
  if (expectBody) check('200 body is the whole fixture', full.bytes === size, full.bytes);

  const partial = await get(`/audio/${SONG_ID}`, { token, range: 'bytes=100-1123' });
  check('Range → 206', partial.status === 206, partial.status);
  check(
    '206 Content-Range is exact',
    partial.headers.get('content-range') === `bytes 100-1123/${size}`,
    partial.headers.get('content-range'),
  );
  check('206 Content-Length is 1024', partial.headers.get('content-length') === '1024');
  check('206 body is 1024 bytes', partial.bytes === 1024, partial.bytes);

  const beyond = await get(`/audio/${SONG_ID}`, { token, range: `bytes=${size + 10}-` });
  check('out-of-range → 416', beyond.status === 416, beyond.status);
  check(
    '416 Content-Range is bytes */size',
    beyond.headers.get('content-range') === `bytes */${size}`,
    beyond.headers.get('content-range'),
  );

  const malformed = await get(`/audio/${SONG_ID}`, { token, range: 'bytes=abc' });
  check('malformed Range → 416', malformed.status === 416, malformed.status);

  const noAuth = await get(`/audio/${SONG_ID}`);
  check('missing token → 401', noAuth.status === 401, noAuth.status);

  const wrongAuth = await get(`/audio/${SONG_ID}`, { token: 'not-the-token' });
  check('wrong token → 401', wrongAuth.status === 401, wrongAuth.status);
}

async function runFast() {
  const fixture = ensureFastFixture();
  const size = statSync(fixture).size;

  console.log('— readiness / token lifecycle');
  let server = startServer([
    '--fixture',
    fixture,
    '--no-throttle',
    '--publish-delay-ms',
    String(PUBLISH_DELAY_MS),
  ]);
  try {
    await waitFor('listen', () => server.out.includes('[spike] listening'));
    // Deterministic thanks to the publish barrier: the port is open but the
    // token is not on disk yet, so readiness must still be false.
    const early = await fetch(`${BASE}/healthz`);
    check('healthz is 503 before the token is published', early.status === 503, early.status);

    await waitFor('ready', () => server.out.includes('[spike] ready gen='));
    const healthy = await fetch(`${BASE}/healthz`);
    check('healthz is 200 once ready', healthy.status === 200, healthy.status);

    const token = readFileSync(TOKEN_PATH, 'utf8').trim();
    const mode = statSync(TOKEN_PATH).mode & 0o777;
    check('token file is 0600', mode === 0o600, `0${mode.toString(8)}`);
    const generation = readGeneration();

    await assertHttpContract(token, size, { expectBody: true });

    console.log('— competing instance');
    const loser = startServer(['--fixture', fixture, '--no-throttle']);
    await waitFor('loser exit', () => loser.exitCode !== null, 5000);
    check('second instance exits non-zero', loser.exitCode !== 0, loser.exitCode);
    check(
      'loser reports the listen failure',
      loser.err.includes('listen failed'),
      loser.err.trim(),
    );
    check('loser left the token untouched', readFileSync(TOKEN_PATH, 'utf8').trim() === token);
    check('loser left the generation untouched', readGeneration() === generation);

    console.log('— rotation');
    await stopServer(server);
    check('shutdown removes the token file', !existsSync(TOKEN_PATH));

    server = startServer(['--fixture', fixture, '--no-throttle']);
    await waitFor('restart ready', () => server.out.includes('[spike] ready gen='));
    const rotated = readFileSync(TOKEN_PATH, 'utf8').trim();
    check('generation advanced by 1', readGeneration() === generation + 1, readGeneration());
    check('token content changed', rotated !== token);
    const afterRotation = await get(`/audio/${SONG_ID}`, { token, range: 'bytes=0-15' });
    check('the OLD token is now rejected', afterRotation.status === 401, afterRotation.status);
  } finally {
    await stopServer(server);
  }
  check('final shutdown removed the token file', !existsSync(TOKEN_PATH));
}

function runElectronSmoke() {
  return new Promise((resolve) => {
    const child = spawn(electronPath, [MAIN, '--smoke'], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, out });
    });
  });
}

async function runFullLayer() {
  if (!existsSync(REAL_FIXTURE)) {
    fatal(`missing ${REAL_FIXTURE} — run \`just spike-media-fixture\` first`);
  }
  const size = statSync(REAL_FIXTURE).size;
  console.log('— full layer (real fixture, throttled)');
  const server = startServer(['--fixture', REAL_FIXTURE]);
  try {
    await waitFor('ready', () => server.out.includes('[spike] ready gen='));
    const token = readFileSync(TOKEN_PATH, 'utf8').trim();
    // Body assertions are skipped for the 200 case: at 256 KB/s a 70 MB read
    // would take minutes. Headers still prove the contract.
    await assertHttpContract(token, size, { expectBody: false });

    console.log('— electron --smoke (server still live)');
    const smoke = await runElectronSmoke();
    check('electron smoke exits 0', smoke.code === 0, smoke.code);
    check('smoke reported PASS', smoke.out.includes('[smoke] PASS'));
  } finally {
    await stopServer(server);
  }
  check('full-layer shutdown removed the token file', !existsSync(TOKEN_PATH));
}

process.on('exit', () => {
  for (const child of children) child.kill('SIGKILL');
});

try {
  if (FULL) await runFullLayer();
  else await runFast();
} catch (err) {
  console.error(`✗ harness error: ${err.message}`);
  failures += 1;
} finally {
  for (const child of children) child.kill('SIGKILL');
}

console.log(failures === 0 ? '✓ spike harness passed' : `✗ spike harness: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
