// The migration's own three routes (0.3.0 T3b; 判据 16, 21, 51, 59, 61).
//
// The pass itself is not driven here — `migration/runner.test.ts` does that
// with real ffmpeg. What is under test is the surface: what a client is told,
// what it is NOT told (no absolute path leaves the daemon), and the four things
// standing between a click and a deleted backup.

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FileEffectRuntime, paths } from '@lark/core';
import type {
  ApiResponse,
  AudioMigrationBackupClearData,
  AudioMigrationData,
  AudioMigrationRetryData,
  AudioMigrationStatus,
} from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MigrationHandle } from '../lifecycle.js';
import {
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';

let nest: string;
let ctx: TestContext;
let app: TestApp;

/** A migration that records what it was asked to do. */
interface FakeMigration extends MigrationHandle {
  runs: number;
  exclusiveCalls: number;
}

function fakeMigration(ctx: TestContext): FakeMigration {
  const handle: FakeMigration = {
    runs: 0,
    exclusiveCalls: 0,
    state: () => 'blocked_environment',
    reason: () => `磁盘剩余 1MB，音频迁移需要 500MB——${paths.larkDir()} 清理一些空间后重试`,
    run: async () => {
      handle.runs++;
    },
    fileOps: ctx.fileOps as FileEffectRuntime,
    exclusive: async (fn) => {
      handle.exclusiveCalls++;
      return await fn();
    },
    continueAfterFileOp: () => {},
    stop: async () => {},
  };
  return handle;
}

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-migration-routes-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  ctx = createTestContext();
  app = buildTestServer(ctx);
});

afterEach(async () => {
  await app.close();
  await closeTestContext(ctx);
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

function seedLedger(
  objectKey: string,
  status: AudioMigrationStatus,
  options: { lastError?: string; backup?: boolean; bytes?: number } = {},
): void {
  const relative = options.backup === false ? null : join('migration-backup', `${objectKey}.mp3`);
  ctx.sqlite
    .prepare(
      `INSERT INTO audio_migration
         (object_key, song_id, class, source_key_present, status, last_error, backup_path, at)
       VALUES (?, ?, 'A', 0, ?, ?, ?, 0)`,
    )
    .run(objectKey, objectKey, status, options.lastError ?? null, relative);
  if (relative === null) return;
  const absolute = join(paths.larkDir(), relative);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, Buffer.alloc(options.bytes ?? 100, 1));
}

async function report(): Promise<AudioMigrationData> {
  const res = await app.inject({ method: 'GET', url: '/api/audio-migration' });
  expect(res.statusCode).toBe(200);
  return res.json<ApiResponse<AudioMigrationData>>().data as AudioMigrationData;
}

describe('GET /api/audio-migration', () => {
  it('reports every object and what the backup holds', async () => {
    seedLedger('kept', 'kept_unconverted', { bytes: 700 });
    seedLedger('gone', 'lost', { backup: false });

    const data = await report();

    expect(data.counts.total).toBe(2);
    expect(data.counts.kept_unconverted).toBe(1);
    expect(data.objects.map((o) => o.object_key)).toEqual(['gone', 'kept']);
    expect(data.objects[1]).toMatchObject({ status: 'kept_unconverted', backup_file: 'kept.mp3' });
    expect(data.backup).toEqual({
      file_count: 1,
      bytes: 700,
      asset_count: 1,
      asset_bytes: 700,
    });
  });

  it('answers after the migration is over (判据 21)', async () => {
    // The default harness context is already `normal`; the ledger is the
    // report, and a user asking "why is that song gone" arrives long after.
    seedLedger('kept', 'kept_unconverted');

    const data = await report();
    expect(data.counts.phase).toBe('normal');
    expect(data.objects).toHaveLength(1);
  });

  it('lets no absolute path out (判据 21)', async () => {
    const absolute = join(paths.larkDir(), 'songs', 'abc', 'song.mp3');
    seedLedger('abc', 'blocked', { lastError: `EACCES: permission denied, unlink '${absolute}'` });
    ctx.lifecycle.attachMigration(fakeMigration(ctx));

    const data = await report();

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(nest);
    expect(serialized).not.toContain(paths.larkDir());
    expect(data.objects[0]?.last_error).toContain('<lark>/songs/abc/song.mp3');
    // The environment reason goes through the same scrub.
    expect(data.reason).toContain('<lark>');
  });
});

describe('POST /api/audio-migration/retry', () => {
  it('re-runs the pass while the library is not served (判据 59)', async () => {
    // A daemon that is still migrating, which is the only time this does work.
    ctx = await replaceContext({ lifecyclePhase: 'pending' });
    const migration = fakeMigration(ctx);
    ctx.lifecycle.attachMigration(migration);

    const res = await app.inject({ method: 'POST', url: '/api/audio-migration/retry' });
    const data = res.json<ApiResponse<AudioMigrationRetryData>>().data as AudioMigrationRetryData;

    expect(res.statusCode).toBe(200);
    expect(data.started).toBe(true);
    expect(migration.runs).toBe(1);
  });

  it('does not start a pass beside a served library', async () => {
    const migration = fakeMigration(ctx);
    ctx.lifecycle.attachMigration(migration); // finished, but still attached

    const res = await app.inject({ method: 'POST', url: '/api/audio-migration/retry' });
    const data = res.json<ApiResponse<AudioMigrationRetryData>>().data as AudioMigrationRetryData;

    expect(data.started).toBe(false);
    expect(migration.runs).toBe(0);
  });
});

describe('POST /api/audio-migration/backup/clear', () => {
  it('refuses without an explicit confirmation (判据 61)', async () => {
    seedLedger('kept', 'kept_unconverted');

    const res = await app.inject({
      method: 'POST',
      url: '/api/audio-migration/backup/clear',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse<never>>().error_code).toBe('INVALID_BODY');
    expect(statSync(join(paths.migrationBackupDir(), 'kept.mp3')).size).toBe(100);
  });

  it('deletes the backups and forgets them in the ledger (判据 61)', async () => {
    seedLedger('kept', 'kept_unconverted', { bytes: 400 });
    seedLedger('done-one', 'done', { bytes: 600 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/audio-migration/backup/clear',
      payload: { confirm: true },
    });
    const data = res.json<ApiResponse<AudioMigrationBackupClearData>>()
      .data as AudioMigrationBackupClearData;

    expect(data).toEqual({ removed_count: 2, freed_bytes: 1000 });
    const after = await report();
    expect(after.backup).toEqual({
      file_count: 0,
      bytes: 0,
      asset_count: 0,
      asset_bytes: 0,
    });
    expect(after.objects.every((o) => o.backup_file === null)).toBe(true);
    expect(after.objects.every((o) => o.reconcile_action === 'backup_cleared')).toBe(true);
  });

  it('runs under the migration mutex (判据 51)', async () => {
    seedLedger('kept', 'kept_unconverted');
    const migration = fakeMigration(ctx);
    ctx.lifecycle.attachMigration(migration);

    await app.inject({
      method: 'POST',
      url: '/api/audio-migration/backup/clear',
      payload: { confirm: true },
    });

    expect(migration.exclusiveCalls).toBe(1);
  });

  it('is refused outright while the migration is still running (判据 61)', async () => {
    ctx = await replaceContext({ lifecyclePhase: 'pending' });
    seedLedger('kept', 'kept_unconverted');

    const res = await app.inject({
      method: 'POST',
      url: '/api/audio-migration/backup/clear',
      payload: { confirm: true },
    });

    // Not whitelisted: the pass may still be moving files into that directory.
    expect(res.statusCode).toBe(503);
    expect(res.json<ApiResponse<never>>().error_code).toBe('AUDIO_MIGRATION_PENDING');
    expect(statSync(join(paths.migrationBackupDir(), 'kept.mp3')).size).toBe(100);
  });
});

/** Swap in a context with different options, keeping the fixture teardown sane. */
async function replaceContext(options: { lifecyclePhase: 'pending' | 'normal' }) {
  await app.close();
  await closeTestContext(ctx);
  const next = createTestContext(options);
  app = buildTestServer(next);
  return next;
}
