#!/usr/bin/env node
/**
 * Stand-in for the lark daemon's `GET /audio/:id`, for the M0 media spike.
 *
 * Owns the readiness / token lifecycle that M2's real daemon will own:
 *   1. listen succeeds  → this process owns the port (only then may it touch
 *      the generation counter; a losing instance exits without side effects)
 *   2. generation += 1 → mint token → atomic 0600 publish
 *   3. ready = true    → `/healthz` flips from 503 to 200
 *   4. any failure     → close, clean up, exit non-zero
 *
 * Usage: node server.mjs [--fixture <path>] [--no-throttle] [--publish-delay-ms <n>]
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchor every path to the spike directory, never to cwd, so the recipes
// behave identically no matter where they are run from.
const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = join(SPIKE_DIR, '.runtime');
const TOKEN_PATH = join(RUNTIME_DIR, 'daemon-token');
const GENERATION_PATH = join(RUNTIME_DIR, 'generation');
const DEFAULT_FIXTURE = join(SPIKE_DIR, 'fixtures', 'fixture.mp3');

const HOST = '127.0.0.1';
const PORT = 47190; // 471xx band, deliberately clear of the real daemon's 47100
const THROTTLE_BYTES_PER_SEC = 256 * 1024;
const CHUNK_BYTES = 32 * 1024;

function parseArgs(argv) {
  const args = { fixture: DEFAULT_FIXTURE, throttle: true, publishDelayMs: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixture') args.fixture = resolve(argv[++i]);
    else if (argv[i] === '--no-throttle') args.throttle = false;
    else if (argv[i] === '--publish-delay-ms') args.publishDelayMs = Number(argv[++i]);
    else {
      console.error(`[spike] unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!existsSync(args.fixture)) {
  console.error(`[spike] fixture not found: ${args.fixture} (run \`just spike-media-fixture\`)`);
  process.exit(1);
}
const fixtureSize = statSync(args.fixture).size;

let ready = false;
let generation = 0;
let token = null;
let seq = 0;

// Criterion 4 observation point. Counted at the APPLICATION layer: Chromium
// keeps pooled keep-alive sockets and /healthz polling occupies connections, so
// "TCP sockets ≤ 1" is not a usable signal.
let activeAudioResponses = 0;
let activeFileStreams = 0;

function logStreams() {
  console.log(`[spike] streams audio=${activeAudioResponses} files=${activeFileStreams}`);
}

/** Never prints the token itself. */
function logRequest(id, range, status, auth) {
  console.log(`[gen ${generation}] #${id} Range=${range ?? '-'} → ${status} auth=${auth}`);
}

function nextGeneration() {
  let current = 0;
  try {
    current = Number.parseInt(readFileSync(GENERATION_PATH, 'utf8').trim(), 10) || 0;
  } catch {
    current = 0; // first run — no counter file yet
  }
  const next = current + 1;
  writeFileSync(GENERATION_PATH, `${next}\n`);
  return next;
}

/**
 * Atomic 0600 publish: O_EXCL temp created with the final mode (no
 * default-permission window), then rename over the destination.
 */
function publishToken(value) {
  const tmp = `${TOKEN_PATH}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, value);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, TOKEN_PATH);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already shutting down
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // temp may never have been created
    }
    throw err;
  }
}

/** `{ kind: 'full' | 'partial' | 'invalid' }` — invalid covers malformed AND unsatisfiable. */
function parseRange(header, size) {
  if (header === undefined) return { kind: 'full' };
  const match = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return { kind: 'invalid' };
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { kind: 'invalid' };
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix <= 0) return { kind: 'invalid' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start > end || start >= size) return { kind: 'invalid' };
  return { kind: 'partial', start, end };
}

/**
 * Stream `[start, end]` of the fixture, paced when throttling is on.
 *
 * The throttle is not decoration: over loopback the whole file buffers in
 * seconds, after which seeking issues no new requests and a rotated token is
 * never exercised — the whole matrix would pass vacuously. Pacing keeps the far
 * end of the progress bar permanently unbuffered.
 */
function streamRange(res, start, end) {
  const stream = createReadStream(args.fixture, { start, end, highWaterMark: CHUNK_BYTES });

  activeAudioResponses += 1;
  activeFileStreams += 1;
  logStreams();

  // One-shot guard: 'finish' / 'close' / 'error' can all fire on the same
  // response, and double-decrementing would drive the counters negative and
  // make criterion 4 meaningless.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeAudioResponses -= 1;
    activeFileStreams -= 1;
    stream.destroy();
    logStreams();
  };

  res.on('finish', release);
  res.on('close', release);
  res.on('error', release);
  stream.on('error', release);
  stream.on('close', release);

  if (!args.throttle) {
    stream.pipe(res);
    return;
  }

  // Pace AND honour backpressure: the next chunk waits for both the rate timer
  // and the socket actually flushing this one. Ignoring the flush callback (a
  // first cut did) means an abandoned response keeps buffering unread bytes in
  // memory and never learns the peer is gone — the stream counter then only
  // falls minutes later. The real daemon's /audio has the same obligation.
  stream.on('data', (chunk) => {
    stream.pause();
    let flushed = false;
    let paced = false;
    const resume = () => {
      if (flushed && paced && !released) stream.resume();
    };
    res.write(chunk, () => {
      flushed = true;
      resume();
    });
    setTimeout(
      () => {
        paced = true;
        resume();
      },
      (chunk.length / THROTTLE_BYTES_PER_SEC) * 1000,
    );
  });
  stream.on('end', () => res.end());
}

function handleAudio(req, res) {
  const range = req.headers.range;
  const auth = req.headers.authorization;
  const authorized =
    typeof auth === 'string' && auth.startsWith('Bearer ') && auth.slice(7) === token;
  const seqId = ++seq;

  if (!authorized) {
    logRequest(seqId, range, 401, 'fail');
    res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('unauthorized');
    return;
  }

  const parsed = parseRange(range, fixtureSize);
  const common = {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  if (parsed.kind === 'invalid') {
    logRequest(seqId, range, 416, 'ok');
    res.writeHead(416, { ...common, 'Content-Range': `bytes */${fixtureSize}` });
    res.end();
    return;
  }

  if (parsed.kind === 'full') {
    // A 200 still needs Content-Length + Accept-Ranges: the media element
    // derives total duration and seekability from them.
    logRequest(seqId, range, 200, 'ok');
    res.writeHead(200, { ...common, 'Content-Length': String(fixtureSize) });
    streamRange(res, 0, fixtureSize - 1);
    return;
  }

  const length = parsed.end - parsed.start + 1;
  logRequest(seqId, range, 206, 'ok');
  res.writeHead(206, {
    ...common,
    'Content-Length': String(length),
    'Content-Range': `bytes ${parsed.start}-${parsed.end}/${fixtureSize}`,
  });
  streamRange(res, parsed.start, parsed.end);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (url.pathname === '/healthz') {
    res.writeHead(ready ? 200 : 503, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ ready, generation }));
    return;
  }

  if (url.pathname.match(/^\/audio\/[^/]+$/)) {
    handleAudio(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.on('error', (err) => {
  // A competing instance lands here: it never owned the port, so it must not
  // touch the generation counter or the published token.
  console.error(`[spike] listen failed: ${err.code ?? err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  console.log(
    `[spike] listening port=${PORT} throttle=${args.throttle} size=${fixtureSize} fixture=${args.fixture}`,
  );
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    // Test-only barrier: without it the 503 window is microseconds wide and no
    // automated observation of "not ready yet" could be deterministic.
    if (args.publishDelayMs > 0) {
      await new Promise((r) => setTimeout(r, args.publishDelayMs));
    }
    generation = nextGeneration();
    token = randomBytes(32).toString('base64url');
    publishToken(token);
    ready = true;
    console.log(`[spike] ready gen=${generation}`);
  } catch (err) {
    console.error(`[spike] publish failed: ${err.message}`);
    server.close();
    process.exit(1);
  }
});

function shutdown() {
  console.log(`[spike] shutdown gen=${generation}`);
  try {
    unlinkSync(TOKEN_PATH);
  } catch {
    // already gone
  }
  server.closeAllConnections();
  server.close(() => process.exit(0));
  // Throttled streams can hold the loop open — never hang the recipe.
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
