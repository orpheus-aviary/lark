// 判据 1: each of the three checks stops the pass on its own, before a file
// is touched. The point of doing them up front is that the alternative —
// finding out halfway — leaves a library in two formats and a disk with no
// room to finish.

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/index.js';
import { probeCapabilities } from '../media-tools/capabilities.js';
import { type ResolvedMediaTools, resolveMediaTools } from '../media-tools/resolve.js';
import { larkDir, songsDir } from '../paths.js';
import { MIN_FREE_BYTES, SIZE_HEADROOM, preflightAudioMigration } from './preflight.js';
import { scanAudioMigration } from './scanner.js';

let nest: string;
let sqlite: BetterSqlite3.Database;
let tools: ResolvedMediaTools;

const PLENTY = async () => 100 * 1024 * 1024 * 1024;

beforeAll(async () => {
  const outcome = resolveMediaTools();
  if (!outcome.ok) throw new Error(`no usable ffmpeg for the test run: ${outcome.detail}`);
  const probe = await probeCapabilities(outcome.tools);
  if (probe.state !== 'ready') {
    throw new Error(`no usable ffmpeg for the test run (${probe.state}): ${probe.detail}`);
  }
  tools = outcome.tools;
}, 60_000);

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-preflight-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

/** One object of `bytes` bytes, in the ledger. */
function seedObject(bytes: number): void {
  const id = randomUUID();
  mkdirSync(join(songsDir(), id), { recursive: true });
  writeFileSync(join(songsDir(), id, 'song.mp3'), Buffer.alloc(bytes, 1));
  scanAudioMigration(sqlite);
}

describe('preflightAudioMigration', () => {
  it('passes on a healthy machine', async () => {
    seedObject(1024);
    expect(await preflightAudioMigration({ sqlite, tools, freeBytes: PLENTY })).toEqual({
      ok: true,
    });
  }, 60_000);

  it('refuses when the toolchain cannot do the job', async () => {
    const broken = { ...tools, ffmpeg: { ...tools.ffmpeg, path: join(nest, 'no-such-ffmpeg') } };
    const result = await preflightAudioMigration({ sqlite, tools: broken, freeBytes: PLENTY });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain('ffmpeg');
  }, 60_000);

  it('refuses when a directory it needs cannot be created', async () => {
    // A file where the songs directory belongs: `mkdir -p` cannot pass through
    // it, which is what a read-only mount or a stray file looks like here.
    mkdirSync(larkDir(), { recursive: true });
    writeFileSync(songsDir(), 'not a directory');

    const result = await preflightAudioMigration({ sqlite, tools, freeBytes: PLENTY });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain('不可写');
  }, 60_000);

  it('refuses when the disk is too full for the floor', async () => {
    const result = await preflightAudioMigration({
      sqlite,
      tools,
      freeBytes: async () => MIN_FREE_BYTES - 1,
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain('迁移需要');
  }, 60_000);

  // Source, temp output and backup can all be alive at once, so the biggest
  // single file — not the library total — is what has to fit three times over.
  it('asks for three times the largest object once that is over the floor', async () => {
    const big = MIN_FREE_BYTES; // one byte over the floor once tripled
    seedObject(1024);
    seedObject(big);

    expect(
      await preflightAudioMigration({
        sqlite,
        tools,
        freeBytes: async () => big * SIZE_HEADROOM - 1,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await preflightAudioMigration({
        sqlite,
        tools,
        freeBytes: async () => big * SIZE_HEADROOM,
      }),
    ).toEqual({ ok: true });
  }, 120_000);
});
