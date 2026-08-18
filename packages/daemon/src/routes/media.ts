// `GET /audio/:id`, `GET|DELETE /lyrics/:id` — the two envelope exceptions
// (R15): audio is binary with Range support, lyrics are text/plain LRC.
//
// The Range implementation is ported from the M0 media spike, which is where
// the three obligations below were MEASURED against a real Chromium media
// element (spike §6.2):
//
//   1. Respect backpressure. The spike's first cut wrote chunks on a timer and
//      ignored the flush callback: an abandoned response kept buffering unread
//      bytes and never learned the peer was gone. Here `reply.send(stream)`
//      pipes, so the kernel's flow control is honoured for free — which is
//      exactly why nothing in this file hand-rolls a write loop.
//   2. Budget file descriptors for ~6 concurrent range streams PER SONG.
//      Chromium's multibuffer keeps several range connections alive and
//      reuses them across seeks, so a "one stream per song" assumption
//      under-counts by 6x.
//   3. Release once, on `close`/`error`, through an idempotent guard. Those
//      events can both fire for the same response; double-releasing would
//      corrupt the counter and, worse, hide a real fd leak.
//
// And one anti-obligation: do NOT cap a 206 to a fixed chunk size to "help"
// slow sources. Measured result — the media element goes to MEDIA_ERR_NETWORK.

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { type Readable, Transform } from 'node:stream';
import { deleteLyrics, getSong, readLyrics, songAudioPath, touchLastAccessed } from '@lark/core';
import { apiPath } from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail, ok } from '../response.js';
import { pathUuid } from '../validation.js';

/**
 * `last_accessed_at` drives cache eviction (M5), so per-request precision buys
 * nothing while a seek storm would otherwise mean a write per range request.
 */
const TOUCH_DEBOUNCE_MS = 60_000;

export type ParsedRange =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'invalid' };

/**
 * Parse a `Range` header against a known size (spike-verified rules):
 * a suffix range clamps to the file start, an open-ended range runs to EOF,
 * and anything malformed / unsatisfiable collapses to `invalid` → 416. Only
 * single-range requests are honoured; a multi-range header (`bytes=0-1,5-6`)
 * fails the pattern and is a 416, which clients handle by re-requesting.
 */
export function parseRange(header: string | undefined, size: number): ParsedRange {
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

const idOf = (req: { params: unknown }): string => pathUuid((req.params as { id: string }).id);

/** Positive rate = acceptance mode asked for paced writes; otherwise none. */
function throttleFor(ctx: AppContext): number | undefined {
  const rate = ctx.acceptance?.audioThrottleBytesPerSec;
  return rate !== undefined && rate > 0 ? rate : undefined;
}

/**
 * Pace a stream at roughly `bytesPerSec`. The delay goes in a Transform rather
 * than a write loop so the pipe still carries backpressure — the obligation
 * the spike measured (§6.2 ①) holds in acceptance mode too.
 */
function throttle(source: Readable, bytesPerSec: number): Readable {
  const paced = new Transform({
    transform(chunk: Buffer, _encoding, done): void {
      setTimeout(() => done(null, chunk), (chunk.length / bytesPerSec) * 1000);
    },
  });
  return source.pipe(paced);
}

export function registerMediaRoutes(app: FastifyInstance, ctx: AppContext): void {
  const lastTouched = new Map<string, number>();

  const touch = (id: string): void => {
    const now = Date.now();
    const previous = lastTouched.get(id);
    if (previous !== undefined && now - previous < TOUCH_DEBOUNCE_MS) return;
    lastTouched.set(id, now);
    touchLastAccessed(ctx.db, ctx.sqlite, id, now);
  };

  app.get(apiPath.audio(':id'), async (req, reply) => {
    const id = idOf(req);
    // Registered BEFORE the first await (M5-5): between "this request exists"
    // and "the file is open" an eviction must already see a reader, or it can
    // delete the file this response is about to stream. Every exit below —
    // including the two 404s, the 416 and any throw — goes through the same
    // idempotent release.
    const releaseCount = ctx.audioStreams.register(id);
    let released = false;
    const releaseSlot = (): void => {
      if (released) return;
      released = true;
      releaseCount();
    };

    try {
      getSong(ctx.db, ctx.sqlite, id); // unknown song → 404 NOT_FOUND

      const path = songAudioPath(id);
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // The row exists but the payload does not: a distinct condition from
        // "no such song" — the GUI offers a (re)download for this one.
        releaseSlot();
        return fail(reply, 404, 'audio file not found for this song', 'FILE_NOT_FOUND');
      }

      const parsed = parseRange(req.headers.range, size);
      reply
        .header('Content-Type', 'audio/mp4')
        .header('Accept-Ranges', 'bytes')
        .header('Cache-Control', 'no-store');

      if (parsed.kind === 'invalid') {
        ctx.logger.debug({ song_id: id, range: req.headers.range, status: 416 }, 'audio range');
        releaseSlot();
        // 416 MUST carry the total size so the client can re-ask sensibly.
        return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      }

      touch(id);
      // The stream itself is the protection from here on, so the ensure lease
      // that was standing in for it has done its job (M5-6).
      ctx.cacheLeases.clear(id);

      const start = parsed.kind === 'full' ? 0 : parsed.start;
      const end = parsed.kind === 'full' ? size - 1 : parsed.end;
      const length = end - start + 1;
      // A 200 still needs Content-Length + Accept-Ranges: the media element
      // derives duration and seekability from them.
      reply.code(parsed.kind === 'full' ? 200 : 206).header('Content-Length', String(length));
      if (parsed.kind === 'partial') {
        reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
      }

      const stream = createReadStream(path, { start, end });
      // Acceptance mode only: pacing the bytes is what makes a seek land on
      // something that is genuinely not buffered yet (M4 T6).
      const rate = throttleFor(ctx);
      const body = rate === undefined ? stream : throttle(stream, rate);
      const release = (): void => {
        if (released) return;
        releaseSlot();
        stream.destroy();
        if (body !== stream) body.destroy();
      };
      // 'close' also fires on a client that seeks away mid-stream; 'error' on a
      // reset socket. Both must release, exactly once, or the fd leaks.
      reply.raw.on('close', release);
      reply.raw.on('error', release);
      stream.on('close', release);
      stream.on('error', release);
      if (body !== stream) {
        body.on('close', release);
        body.on('error', release);
      }

      ctx.logger.debug(
        {
          song_id: id,
          range: req.headers.range ?? null,
          status: parsed.kind === 'full' ? 200 : 206,
          bytes: length,
          open_streams: ctx.audioStreams.total(),
        },
        'audio range',
      );
      return reply.send(body);
    } catch (err) {
      releaseSlot();
      throw err;
    }
  });

  app.get(apiPath.lyrics(':id'), async (req, reply) => {
    const id = idOf(req);
    const text = await readLyrics(id);
    if (text === null) return fail(reply, 404, 'lyrics not found', 'LYRICS_NOT_FOUND');
    return reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(text);
  });

  app.delete(apiPath.lyrics(':id'), async (req, reply) => {
    const id = idOf(req);
    // "Is there a file?" and "delete it" are two syscalls, and a lyrics task
    // can land one in between. The claim closes that window; it is `lyrics`
    // rather than `exclusive`, so deleting lyrics never blocks a download.
    const token = ctx.downloads.claims.acquire(id, 'lyrics', `route:${randomUUID()}`);
    let deleted: boolean;
    try {
      deleted = await deleteLyrics(ctx.portable, id);
    } finally {
      ctx.downloads.claims.release(token);
    }
    if (!deleted) return fail(reply, 404, 'lyrics not found', 'LYRICS_NOT_FOUND');
    ctx.eventsBus.emit({ type: 'lyrics:changed', song_id: id });
    return ok(reply, { id }, 'lyrics deleted');
  });
}
