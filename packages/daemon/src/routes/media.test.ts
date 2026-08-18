// Range semantics are what a media element actually consumes, so these run
// against a real listening server (inject does not model streamed bodies).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSong, songDirPath, songLyricsPath } from '@lark/core';
import type { ApiResponse, LarkEvent, SongData } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TEST_LOCAL_TOKEN,
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';
import { parseRange } from './media.js';

const UNKNOWN_UUID = '9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001';
const AUDIO_BYTES = 4096;

let ctx: TestContext;
let app: TestApp;
let base: string;
let nest: string;
let events: LarkEvent[];
let song: SongData;

const auth = { authorization: `Bearer ${TEST_LOCAL_TOKEN}` };

/** Deterministic body so a byte-range assertion means something. */
function audioFixture(size = AUDIO_BYTES): Buffer {
  return Buffer.from(Array.from({ length: size }, (_, i) => i % 251));
}

function writeAudio(id: string, body: Buffer): void {
  mkdirSync(songDirPath(id), { recursive: true });
  writeFileSync(join(songDirPath(id), 'song.m4a'), body);
}

beforeEach(async () => {
  nest = mkdtempSync(join(tmpdir(), 'lark-media-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  ctx = createTestContext();
  app = buildTestServer(ctx);
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  events = [];
  ctx.eventsBus.subscribe((e) => events.push(e));
  song = createSong(ctx.portable, { name: 'fixture' });
});

afterEach(async () => {
  await app.close();
  await closeTestContext(ctx);
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

describe('parseRange', () => {
  it.each([
    ['no header', undefined, { kind: 'full' }],
    ['a closed range', 'bytes=0-1023', { kind: 'partial', start: 0, end: 1023 }],
    ['an open-ended range', 'bytes=1000-', { kind: 'partial', start: 1000, end: 4095 }],
    ['a suffix range', 'bytes=-100', { kind: 'partial', start: 3996, end: 4095 }],
    ['an end past EOF (clamped)', 'bytes=4000-99999', { kind: 'partial', start: 4000, end: 4095 }],
    ['a suffix larger than the file', 'bytes=-99999', { kind: 'partial', start: 0, end: 4095 }],
    ['a start past EOF', 'bytes=4096-', { kind: 'invalid' }],
    ['a reversed range', 'bytes=200-100', { kind: 'invalid' }],
    ['a multi-range header', 'bytes=0-10,20-30', { kind: 'invalid' }],
    ['a bare dash', 'bytes=-', { kind: 'invalid' }],
    ['a zero suffix', 'bytes=-0', { kind: 'invalid' }],
    ['junk', 'pages=1-2', { kind: 'invalid' }],
  ])('handles %s', (_label, header, expected) => {
    expect(parseRange(header as string | undefined, AUDIO_BYTES)).toEqual(expected);
  });
});

describe('GET /audio/:id', () => {
  it('serves the whole file with the headers a media element needs', async () => {
    const body = audioFixture();
    writeAudio(song.id, body);

    const res = await fetch(`${base}/audio/${song.id}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mp4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(AUDIO_BYTES));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
  });

  it('serves an exact 1024-byte window as 206', async () => {
    const body = audioFixture();
    writeAudio(song.id, body);

    const res = await fetch(`${base}/audio/${song.id}`, {
      headers: { ...auth, range: 'bytes=1024-2047' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-length')).toBe('1024');
    expect(res.headers.get('content-range')).toBe(`bytes 1024-2047/${AUDIO_BYTES}`);
    expect(Buffer.from(await res.arrayBuffer()).equals(body.subarray(1024, 2048))).toBe(true);
  });

  it.each([
    ['open-ended', 'bytes=4000-', 96, `bytes 4000-4095/${AUDIO_BYTES}`],
    ['suffix', 'bytes=-100', 100, `bytes 3996-4095/${AUDIO_BYTES}`],
  ])('serves an %s range', async (_label, range, length, contentRange) => {
    writeAudio(song.id, audioFixture());
    const res = await fetch(`${base}/audio/${song.id}`, { headers: { ...auth, range } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-length')).toBe(String(length));
    expect(res.headers.get('content-range')).toBe(contentRange);
    await res.arrayBuffer();
  });

  it.each([['bytes=99999-'], ['bytes=200-100'], ['bytes=0-10,20-30'], ['bytes=-0']])(
    '416s %s with the total size',
    async (range) => {
      writeAudio(song.id, audioFixture());
      const res = await fetch(`${base}/audio/${song.id}`, { headers: { ...auth, range } });
      expect(res.status).toBe(416);
      expect(res.headers.get('content-range')).toBe(`bytes */${AUDIO_BYTES}`);
      await res.arrayBuffer();
    },
  );

  it('streams a multi-chunk file to the last byte, exactly', async () => {
    // The other fixtures fit in one read; a truncation past the first
    // highWaterMark chunk would slip through them entirely — and `curl -s`
    // hides "transfer closed with N bytes remaining", so it would surface as
    // a corrupt file rather than an error (found during M2 acceptance).
    const body = audioFixture(3 * 1024 * 1024 + 7);
    writeAudio(song.id, body);

    const full = await fetch(`${base}/audio/${song.id}`, { headers: auth });
    expect(full.headers.get('content-length')).toBe(String(body.length));
    expect(Buffer.from(await full.arrayBuffer()).equals(body)).toBe(true);

    const tail = await fetch(`${base}/audio/${song.id}`, {
      headers: { ...auth, range: `bytes=${body.length - 100_000}-` },
    });
    expect(tail.status).toBe(206);
    expect(Buffer.from(await tail.arrayBuffer()).equals(body.subarray(body.length - 100_000))).toBe(
      true,
    );
  });

  it('separates "no such song" from "no file for this song"', async () => {
    const missingSong = await fetch(`${base}/audio/${UNKNOWN_UUID}`, { headers: auth });
    expect(missingSong.status).toBe(404);
    expect(((await missingSong.json()) as ApiResponse).error_code).toBe('NOT_FOUND');

    const missingFile = await fetch(`${base}/audio/${song.id}`, { headers: auth });
    expect(missingFile.status).toBe(404);
    expect(((await missingFile.json()) as ApiResponse).error_code).toBe('FILE_NOT_FOUND');

    const malformed = await fetch(`${base}/audio/not-a-uuid`, { headers: auth });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as ApiResponse).error_code).toBe('INVALID_ID');
  });

  it('releases the file stream exactly once when the client aborts mid-stream', async () => {
    writeAudio(song.id, audioFixture(8 * 1024 * 1024));
    expect(ctx.audioStreams.total()).toBe(0);

    const controller = new AbortController();
    const res = await fetch(`${base}/audio/${song.id}`, {
      headers: auth,
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    await reader?.read(); // consume one chunk, leaving the rest unread
    expect(ctx.audioStreams.total()).toBe(1);

    controller.abort();
    await vi.waitFor(() => expect(ctx.audioStreams.total()).toBe(0));
  });

  // The stream slot is taken at the top of the handler, before the first
  // await, so eviction can never delete a file out from under an accepted
  // request (M5-5). That makes releasing it on EVERY exit the obligation.
  it.each([
    ['an unknown song', () => `${base}/audio/${UNKNOWN_UUID}`, {}],
    ['a song with no file', () => `${base}/audio/${song.id}`, {}],
    ['an unsatisfiable range', () => `${base}/audio/${song.id}`, { range: 'bytes=99999-' }],
    ['a malformed id', () => `${base}/audio/not-a-uuid`, {}],
  ])('leaves no stream registered after %s', async (_label, url, headers) => {
    if (_label === 'an unsatisfiable range') writeAudio(song.id, audioFixture());
    const res = await fetch(url(), { headers: { ...auth, ...headers } });
    await res.arrayBuffer();
    expect(ctx.audioStreams.total()).toBe(0);
  });

  it('counts streams per song and clears the ensure lease once one opens', async () => {
    writeAudio(song.id, audioFixture(8 * 1024 * 1024));
    ctx.cacheLeases.grant(song.id);

    const controller = new AbortController();
    const res = await fetch(`${base}/audio/${song.id}`, {
      headers: auth,
      signal: controller.signal,
    });
    await res.body?.getReader().read();

    expect(ctx.audioStreams.count(song.id)).toBe(1);
    expect(ctx.audioStreams.count(UNKNOWN_UUID)).toBe(0);
    // The open stream protects the file from here on, so the lease is spent.
    expect(ctx.cacheLeases.has(song.id)).toBe(false);

    controller.abort();
    await vi.waitFor(() => expect(ctx.audioStreams.count(song.id)).toBe(0));
  });

  it('debounces last_accessed_at instead of writing per range request', async () => {
    writeAudio(song.id, audioFixture());
    const readAccess = (): number | null =>
      (
        ctx.sqlite.prepare('SELECT last_accessed_at AS at FROM songs WHERE id = ?').get(song.id) as
          | { at: number | null }
          | undefined
      )?.at ?? null;

    await (await fetch(`${base}/audio/${song.id}`, { headers: auth })).arrayBuffer();
    expect(readAccess()).not.toBeNull();

    // A marker the route would overwrite if it touched again.
    ctx.sqlite.prepare('UPDATE songs SET last_accessed_at = 42 WHERE id = ?').run(song.id);
    await (
      await fetch(`${base}/audio/${song.id}`, { headers: { ...auth, range: 'bytes=0-99' } })
    ).arrayBuffer();
    expect(readAccess()).toBe(42);
  });
});

describe('lyrics', () => {
  const writeLyrics = (text: string): void => {
    mkdirSync(songDirPath(song.id), { recursive: true });
    writeFileSync(songLyricsPath(song.id), text);
  };

  it('serves LRC as plain text', async () => {
    writeLyrics('[00:01.00]第一行');
    const res = await fetch(`${base}/lyrics/${song.id}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('[00:01.00]第一行');
  });

  it('404s when there is no lyrics file', async () => {
    const res = await fetch(`${base}/lyrics/${song.id}`, { headers: auth });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiResponse).error_code).toBe('LYRICS_NOT_FOUND');
  });

  it('deletes once, announces it, and 404s the second time', async () => {
    writeLyrics('[00:01.00]x');

    const first = await fetch(`${base}/lyrics/${song.id}`, { method: 'DELETE', headers: auth });
    expect(first.status).toBe(200);
    expect(events).toEqual([{ type: 'lyrics:changed', song_id: song.id }]);

    const second = await fetch(`${base}/lyrics/${song.id}`, { method: 'DELETE', headers: auth });
    expect(second.status).toBe(404);
    expect(events).toHaveLength(1);
  });
});
