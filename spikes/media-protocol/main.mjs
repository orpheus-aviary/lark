#!/usr/bin/env electron
/**
 * Electron main process for the M0 media spike (R21).
 *
 * Validates exactly the three APIs M4 will port into `@lark/gui`:
 * `registerSchemesAsPrivileged` → `protocol.handle` → `net.fetch` passthrough,
 * with the token read fresh from a 0600 file on every request.
 *
 * Usage: electron main.mjs [--smoke]
 *   --smoke                    headless: assert one 206 + exact body/headers, then exit
 *   LARK_SPIKE_CACHE_TOKEN=1   deliberately WRONG behaviour (cache the token at
 *                              startup) so criterion 6 can be verified negatively
 *                              without hand-editing code
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { net, BrowserWindow, app, protocol } from 'electron';

const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = join(SPIKE_DIR, '.runtime', 'daemon-token');
const DAEMON_ORIGIN = 'http://127.0.0.1:47190';

/** The single song id the spike serves; the fixture is the same file either way. */
const FIXTURE_ID = '9e107d9d-372b-4e39-a3ee-8b2f3d1c4a5b';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
];

const SMOKE = process.argv.includes('--smoke');
const CACHE_TOKEN = process.env.LARK_SPIKE_CACHE_TOKEN === '1';

// Must run before app ready. `standard` gives the scheme a real origin (and the
// host/path parsing the validation below relies on); `stream` + `supportFetchAPI`
// are what make <audio> issue ranged requests through the handler.
protocol.registerSchemesAsPrivileged([
  { scheme: 'lark-media', privileges: { standard: true, stream: true, supportFetchAPI: true } },
]);

let cachedToken = null;

/**
 * R29 — re-read per request so a daemon restart's rotated token is picked up
 * without restarting the app. The env switch flips this to the broken variant
 * on purpose (see file header).
 */
function readToken() {
  if (!CACHE_TOKEN) return readFileSync(TOKEN_PATH, 'utf8').trim();
  if (cachedToken === null) cachedToken = readFileSync(TOKEN_PATH, 'utf8').trim();
  return cachedToken;
}

/**
 * Strict URL validation (R10): `lark-media://song/<uuid-v4>` and nothing else —
 * no credentials, no port, no query, no fragment, no extra path segments.
 * Returns the song id, or null when anything is off.
 */
function songIdFromUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'lark-media:') return null;
  if (url.hostname !== 'song') return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  const id = url.pathname.slice(1);
  if (url.pathname !== `/${id}`) return null;
  return UUID_V4.test(id) ? id : null;
}

async function handleMediaRequest(request) {
  const id = songIdFromUrl(request.url);
  if (id === null) {
    console.log(`[main] rejected url=${request.url}`);
    return new Response('invalid lark-media url', { status: 400 });
  }

  let token;
  try {
    token = readToken();
  } catch {
    return new Response('token unavailable', { status: 503 });
  }

  const headers = { Authorization: `Bearer ${token}` };
  const range = request.headers.get('range');
  if (range !== null) headers.Range = range;

  try {
    const upstream = await net.fetch(`${DAEMON_ORIGIN}/audio/${id}`, {
      headers,
      bypassCustomProtocolHandlers: true,
    });
    const out = new Headers();
    for (const name of PASSTHROUGH_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    console.log(`[main] ${range ?? '-'} → ${upstream.status}`);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (err) {
    console.error(`[main] upstream failed: ${err.message}`);
    return new Response('upstream unreachable', { status: 502 });
  }
}

/** Ready handshake — never open the window against a daemon that has no token yet. */
async function waitForDaemon(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await net.fetch(`${DAEMON_ORIGIN}/healthz`, {
        bypassCustomProtocolHandlers: true,
      });
      if (res.status === 200) return true;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function runSmoke() {
  const res = await net.fetch(`lark-media://song/${FIXTURE_ID}`, {
    headers: { Range: 'bytes=0-1023' },
  });
  const body = Buffer.from(await res.arrayBuffer());
  const checks = [
    ['status is 206', res.status === 206, res.status],
    ['body is exactly 1024 bytes', body.length === 1024, body.length],
    [
      'Content-Length: 1024',
      res.headers.get('content-length') === '1024',
      res.headers.get('content-length'),
    ],
    [
      'Content-Range: bytes 0-1023/<size>',
      /^bytes 0-1023\/\d+$/.test(res.headers.get('content-range') ?? ''),
      res.headers.get('content-range'),
    ],
    [
      'Accept-Ranges: bytes',
      res.headers.get('accept-ranges') === 'bytes',
      res.headers.get('accept-ranges'),
    ],
    [
      'Content-Type: audio/mpeg',
      res.headers.get('content-type') === 'audio/mpeg',
      res.headers.get('content-type'),
    ],
  ];

  let failed = 0;
  for (const [label, pass, actual] of checks) {
    console.log(`${pass ? '  ✓' : '  ✗'} ${label}${pass ? '' : ` (got ${actual})`}`);
    if (!pass) failed += 1;
  }
  // Rejection path is part of the contract too.
  const bad = await net.fetch('lark-media://song/not-a-uuid');
  const badOk = bad.status === 400;
  console.log(
    `${badOk ? '  ✓' : '  ✗'} invalid id rejected with 400${badOk ? '' : ` (got ${bad.status})`}`,
  );
  if (!badOk) failed += 1;

  console.log(failed === 0 ? '[smoke] PASS' : `[smoke] FAIL (${failed})`);
  app.exit(failed === 0 ? 0 : 1);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 560,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // Mirror renderer console output into the terminal so CSP violations and
  // media errors are observable next to the server log (criteria 4/5/6).
  win.webContents.on('console-message', (event) => {
    console.log(`[renderer:${event.level}] ${event.message}`);
  });
  win.loadFile(join(SPIKE_DIR, 'index.html'));
  // Docked, not `mode: 'detach'`: with a detached devtools window the page's
  // CDP target reports an empty document, which makes the criteria unscriptable
  // (and hid the real DOM during this spike's own verification).
  win.webContents.openDevTools({ mode: 'bottom' });
  return win;
}

/**
 * NOT top-level await: Electron only emits `ready` after the ESM entry module
 * finishes evaluating, so `await app.whenReady()` at the top level deadlocks the
 * app (verified on Electron 43.2.0 — no window, no output, no exit). Wrapping it
 * in an async function lets evaluation finish, and `ready` then fires normally.
 * M4 must keep this shape when porting into gui main.
 */
async function bootstrap() {
  await app.whenReady();
  protocol.handle('lark-media', handleMediaRequest);

  if (!(await waitForDaemon())) {
    console.error('[main] daemon never became ready — start `just spike-media-server` first');
    app.exit(1);
    return;
  }

  if (SMOKE) {
    await runSmoke();
    return;
  }

  console.log(
    `[main] token mode: ${CACHE_TOKEN ? 'CACHED (negative test)' : 'per-request re-read'}`,
  );
  createWindow();
  app.on('window-all-closed', () => app.quit());
}

void bootstrap();
