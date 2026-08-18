// The acceptance seams must not leak into a normal daemon (M4 T6): the debug
// route is absent unless asked for, it is never advertised, and the throttle
// changes pacing only — never the bytes.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSong, songDirPath } from '@lark/core';
import type { ApiResponse, CapabilitiesData, SongData } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TEST_LOCAL_TOKEN,
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';
import { DEBUG_AUDIO_STREAMS_PATH } from './debug.js';

const AUDIO_BYTES = 64 * 1024;
const auth = { authorization: `Bearer ${TEST_LOCAL_TOKEN}` };

let nest: string;
let ctx: TestContext | null = null;
let app: TestApp | null = null;

function audioFixture(size = AUDIO_BYTES): Buffer {
  return Buffer.from(Array.from({ length: size }, (_, i) => i % 251));
}

function writeAudio(id: string, body: Buffer): void {
  mkdirSync(songDirPath(id), { recursive: true });
  writeFileSync(join(songDirPath(id), 'song.m4a'), body);
}

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-accept-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
});

afterEach(async () => {
  if (app) await app.close();
  if (ctx) await closeTestContext(ctx);
  app = null;
  ctx = null;
  rmSync(nest, { recursive: true, force: true });
});

describe('normal mode', () => {
  it('does not serve the debug route', async () => {
    ctx = createTestContext();
    app = buildTestServer(ctx);

    const res = await app.inject({ method: 'GET', url: DEBUG_AUDIO_STREAMS_PATH });
    expect(res.statusCode).toBe(404);
  });

  it('never advertises it in capabilities', async () => {
    ctx = createTestContext({ acceptance: { debugRoutes: true } });
    app = buildTestServer(ctx);

    const listed = await app.inject({ method: 'GET', url: '/api/capabilities' });
    const body = listed.json() as ApiResponse<CapabilitiesData>;
    expect(body.data?.endpoints.some((e) => e.path === DEBUG_AUDIO_STREAMS_PATH)).toBe(false);
    // …and it is genuinely mounted in this mode, so the check above is not
    // passing for the wrong reason.
    const debug = await app.inject({ method: 'GET', url: DEBUG_AUDIO_STREAMS_PATH });
    expect(debug.statusCode).toBe(200);
  });
});

describe('acceptance mode', () => {
  it('reports the open stream count and requires the token', async () => {
    ctx = createTestContext({ acceptance: { debugRoutes: true } });
    app = buildTestServer(ctx);

    const res = await app.inject({ method: 'GET', url: DEBUG_AUDIO_STREAMS_PATH });
    expect(res.json()).toEqual({
      success: true,
      data: { open_audio_streams: ctx.audioStreams.total() },
    });

    const unauthenticated = await app.injectRaw({
      method: 'GET',
      url: DEBUG_AUDIO_STREAMS_PATH,
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('throttles /audio without changing what it serves', async () => {
    ctx = createTestContext({ acceptance: { audioThrottleBytesPerSec: 32 * 1024 } });
    app = buildTestServer(ctx);
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const song: SongData = createSong(ctx.portable, { name: 'throttled' });
    const body = audioFixture();
    writeAudio(song.id, body);

    const started = Date.now();
    const res = await fetch(`${base}/audio/${song.id}`, { headers: auth });
    const received = Buffer.from(await res.arrayBuffer());
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(received.equals(body)).toBe(true);
    // 64 KiB at 32 KiB/s is ~2s; anything under one second means the pacing
    // never happened and the criterion it exists for would be untestable.
    expect(elapsed).toBeGreaterThan(900);
    // The wrapper must not hide the source stream from the release guard.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ctx.audioStreams.total()).toBe(0);
  });
});
