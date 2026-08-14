// The pass, as the daemon drives it (0.3.0 T3; 判据 1, 3, 15, 16, 59).
//
// The conversions are real — real vendored ffmpeg over the real mp3 fixture —
// because the thing being asserted is the ORDER: that the flag is cleared only
// after the tree is clean, that activation happens once and only after the
// flag, and that a machine-level failure leaves every file where it was.
//
// What is faked is the disk being full (`freeBytes`) and, in one case, whether
// a source is still downloadable. Nothing here reaches the network: every mp3
// is valid, so the discard path (the only one that probes) is never taken.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFileBackedSongInTx,
  enqueueLocalDelete,
  isAudioMigrationPending,
  listLedger,
  paths,
} from '@lark/core';
import { readToneMp3 } from '@lark/core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonLifecycle } from '../lifecycle.js';
import {
  type TestContext,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';
import { MigrationRunner } from './runner.js';

let nest: string;
let ctx: TestContext;
let toneMp3: Buffer;
let activations: number;

beforeAll(async () => {
  toneMp3 = await readToneMp3();
});

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-migration-runner-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  ctx = createTestContext({ lifecyclePhase: 'pending' });
  activations = 0;
});

afterEach(async () => {
  await closeTestContext(ctx);
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

/** A migrating library: the flag 0003 would have set, and a fresh phase. */
function markPending(): void {
  ctx.sqlite
    .prepare("UPDATE local_metadata SET value = '1' WHERE key = 'audio_migration_pending'")
    .run();
}

function runner(freeBytes?: () => Promise<number>): MigrationRunner {
  return new MigrationRunner(ctx, {
    onFinished: async () => {
      activations++;
    },
    ...(freeBytes === undefined ? {} : { freeBytes }),
  });
}

/** A downloaded song with an mp3 on disk, the way 0.2.x left it. */
function seedSong(): string {
  const id = randomUUID();
  ctx.sqlite
    .transaction(() => {
      createFileBackedSongInTx(ctx.db, {
        id,
        name: '歌',
        file_origin: 'downloaded',
        source_provider: 'bilibili',
        source_key: `BV1x${id.slice(0, 4)}:9`,
      });
    })
    .immediate();
  const dir = join(paths.songsDir(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'song.mp3'), toneMp3);
  return id;
}

const songFile = (id: string, name: string) => join(paths.songsDir(), id, name);

describe('a library with nothing to convert', () => {
  it('clears the flag and activates on the first pass (判据 15)', async () => {
    markPending();
    await runner().run();

    expect(isAudioMigrationPending(ctx.sqlite)).toBe(false);
    expect(activations).toBe(1);
    expect(listLedger(ctx.sqlite)).toEqual([]);
  });
});

describe('a library holding mp3 files', () => {
  it('converts them, empties the tree, then clears the flag', async () => {
    markPending();
    const first = seedSong();
    const second = seedSong();

    const pass = runner();
    await pass.run();

    for (const id of [first, second]) {
      expect(existsSync(songFile(id, 'song.m4a'))).toBe(true);
      expect(existsSync(songFile(id, 'song.mp3'))).toBe(false);
    }
    expect(listLedger(ctx.sqlite).map((row) => row.status)).toEqual(['done', 'done']);
    expect(isAudioMigrationPending(ctx.sqlite)).toBe(false);
    expect(pass.state()).toBe('finished');
    expect(activations).toBe(1);
  }, 60_000);

  it('activates once even if the pass is run twice', async () => {
    markPending();
    seedSong();
    const pass = runner();

    await pass.run();
    await pass.run();

    expect(activations).toBe(1);
  }, 60_000);
});

describe('when the machine cannot continue (判据 1, 3)', () => {
  it('stops before touching anything and keeps the flag', async () => {
    markPending();
    const id = seedSong();

    const pass = runner(async () => 1024); // a disk with a kilobyte free
    await pass.run();

    expect(pass.state()).toBe('blocked_environment');
    expect(pass.reason()).toContain('磁盘剩余');
    // Not one byte moved: the mp3 is there and no conversion was attempted.
    expect(existsSync(songFile(id, 'song.mp3'))).toBe(true);
    expect(existsSync(songFile(id, 'song.m4a'))).toBe(false);
    expect(isAudioMigrationPending(ctx.sqlite)).toBe(true);
    expect(activations).toBe(0);
    // The ledger was not even written — the check runs before the scan.
    expect(listLedger(ctx.sqlite)).toEqual([]);
  });

  it('picks up where it left off once the machine is fixed (判据 59)', async () => {
    markPending();
    const id = seedSong();

    const blocked = runner(async () => 1024);
    await blocked.run();
    expect(blocked.state()).toBe('blocked_environment');

    // What `POST /api/audio-migration/retry` will do: run the same pass again.
    const retried = runner();
    await retried.run();

    expect(retried.state()).toBe('finished');
    expect(existsSync(songFile(id, 'song.m4a'))).toBe(true);
    expect(isAudioMigrationPending(ctx.sqlite)).toBe(false);
    expect(activations).toBe(1);
  }, 60_000);
});

describe('when a sync file op owns a directory (判据 16)', () => {
  it('leaves it alone, reports it, and does not finish', async () => {
    markPending();
    const held = seedSong();
    enqueueLocalDelete(ctx.sqlite, held);

    const pass = runner();
    await pass.run();

    expect(listLedger(ctx.sqlite).map((row) => row.status)).toEqual(['blocked_file_op']);
    expect(existsSync(songFile(held, 'song.mp3'))).toBe(true);
    expect(pass.state()).toBe('needs_attention');
    expect(isAudioMigrationPending(ctx.sqlite)).toBe(true);
    expect(activations).toBe(0);
  }, 60_000);

  it('resumes and finishes once the op is gone', async () => {
    markPending();
    const held = seedSong();
    enqueueLocalDelete(ctx.sqlite, held);
    await runner().run();

    ctx.sqlite.prepare('DELETE FROM sync_file_ops').run();
    const resumed = runner();
    await resumed.run();

    expect(resumed.state()).toBe('finished');
    expect(existsSync(songFile(held, 'song.m4a'))).toBe(true);
    expect(activations).toBe(1);
  }, 60_000);
});

describe('teardown', () => {
  it('an aborted pass keeps the flag and never activates', async () => {
    markPending();
    const id = seedSong();
    const pass = runner();

    ctx.shutdownController.abort(new Error('daemon shutting down'));
    await pass.run();

    expect(isAudioMigrationPending(ctx.sqlite)).toBe(true);
    expect(activations).toBe(0);
    expect(existsSync(songFile(id, 'song.mp3'))).toBe(true);
  });

  it('stop() is idempotent and ends the pass', async () => {
    markPending();
    seedSong();
    const pass = runner();

    await pass.stop();
    await pass.stop();
    await pass.run();

    expect(activations).toBe(0);
    expect(isAudioMigrationPending(ctx.sqlite)).toBe(true);
  });
});

describe('the phase machine', () => {
  it('hands activation to exactly one caller', () => {
    const lifecycle = new DaemonLifecycle('pending');

    expect(lifecycle.phase).toBe('pending');
    expect(lifecycle.beginActivation()).toBe(true);
    expect(lifecycle.phase).toBe('activating');
    expect(lifecycle.beginActivation()).toBe(false);

    lifecycle.finishActivation();
    expect(lifecycle.phase).toBe('normal');
  });

  it('a library that owed nothing never leaves normal', () => {
    const lifecycle = new DaemonLifecycle('normal');

    expect(lifecycle.beginActivation()).toBe(true);
    expect(lifecycle.phase).toBe('normal');
    lifecycle.finishActivation();
    expect(lifecycle.phase).toBe('normal');
  });

  it('a failed activation serves nothing', () => {
    const lifecycle = new DaemonLifecycle('pending');
    lifecycle.beginActivation();
    lifecycle.fail();

    expect(lifecycle.phase).toBe('fatal');
  });
});
