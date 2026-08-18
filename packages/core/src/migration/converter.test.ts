// The state machine and the reconciliation table, row by row (判据 5–13, 50, 52).
//
// The conversions are real: a real vendored ffmpeg over the real mp3 fixture,
// damaged in the ways `damageMp3` produces. That matters most for the case
// nothing else can catch — a truncated mp3 that ffmpeg converts happily and
// exits 0 on, which must NOT end with the original being deleted.
//
// The restart cases are built the way a crash builds them: put the files and
// the ledger row into the state the machine would have left, then step it and
// assert where it lands.

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/index.js';
import { createFileBackedSongInTx } from '../library/songs.js';
import { probeCapabilities } from '../media-tools/capabilities.js';
import { type ResolvedMediaTools, resolveMediaTools } from '../media-tools/resolve.js';
import { migrationBackupDir, songsDir } from '../paths.js';
import type { PortableDb } from '../portable/db.js';
import { type Mp3Damage, damageMp3, readToneMp3 } from '../testing/mp3-fixture.js';
import { type ConverterContext, type StepResult, stepObject } from './converter.js';
import { type LedgerRow, type LedgerUpdate, getLedgerRow, updateLedgerRow } from './ledger.js';
import { scanAudioMigration } from './scanner.js';

let nest: string;
let store!: PortableDb;
let sqlite: BetterSqlite3.Database;
let tools: ResolvedMediaTools;
let toneMp3: Buffer;
/** A real, valid m4a of the fixture — what a finished conversion looks like. */
let goodM4a: Buffer;

/** Every source this test says is still downloadable. */
let liveSources: Set<string>;
let probeCalls: string[];

beforeAll(async () => {
  const outcome = resolveMediaTools();
  if (!outcome.ok) throw new Error(`no usable ffmpeg for the test run: ${outcome.detail}`);
  const probe = await probeCapabilities(outcome.tools);
  if (probe.state !== 'ready') {
    throw new Error(`no usable ffmpeg for the test run (${probe.state}): ${probe.detail}`);
  }
  tools = outcome.tools;
  toneMp3 = await readToneMp3();

  // Produced once, by the code under test, so the "already converted" fixture
  // is exactly what this machine writes rather than a checked-in guess.
  const scratch = mkdtempSync(join(tmpdir(), 'lark-converter-seed-'));
  try {
    const nestDir = join(scratch, 'nest');
    vi.stubEnv('LARK_NEST_DIR', nestDir);
    const handles = createDatabase({ dbPath: ':memory:' });
    const id = randomUUID();
    seedRow(handles.portable, handles.sqlite, id, {});
    writeFileSync(join(makeDir(id), 'song.mp3'), toneMp3);
    scanAudioMigration(handles.sqlite);
    await stepObject(context(handles.sqlite), row(handles.sqlite, id));
    goodM4a = readFileSync(join(songsDir(), id, 'song.m4a'));
    handles.sqlite.close();
  } finally {
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-converter-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  ({ sqlite, portable: store } = createDatabase({ dbPath: ':memory:' }));
  liveSources = new Set();
  probeCalls = [];
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllEnvs();
  // A test may have made a directory unwritable to force a blocked row.
  for (const entry of existsSync(songsDir()) ? readdirSync(songsDir()) : []) {
    chmodSync(join(songsDir(), entry), 0o700);
  }
  rmSync(nest, { recursive: true, force: true });
});

// ─── Builders ──────────────────────────────────────────

function context(handle: BetterSqlite3.Database = sqlite): ConverterContext {
  return {
    sqlite: handle,
    tools,
    canRedownload: async (key) => {
      probeCalls.push(key);
      return liveSources.has(key);
    },
  };
}

function makeDir(name: string): string {
  const dir = join(songsDir(), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface SeedOptions {
  origin?: 'downloaded' | 'imported';
  key?: string | null;
}

function seedRow(
  database: PortableDb,
  handle: BetterSqlite3.Database,
  id: string,
  options: SeedOptions,
): void {
  handle
    .transaction(() => {
      createFileBackedSongInTx(database, {
        id,
        name: '歌',
        file_origin: options.origin ?? 'downloaded',
        source_provider: options.key === null ? null : 'bilibili',
        source_key: options.key === null ? null : (options.key ?? `BV1x${id.slice(0, 4)}:9`),
      });
    })
    .immediate();
}

interface SeedFiles {
  /** How the mp3 should be damaged, or absent for none. */
  mp3?: Mp3Damage | 'good' | 'none';
  m4a?: 'good' | 'junk';
  backup?: Buffer | 'same';
}

/**
 * A library song, its directory, and a ledger row from a real scan.
 *
 * `mp3: 'none'` still writes one for the scan and removes it afterwards: the
 * scanner only records objects that HOLD an mp3, so a row for a directory
 * without one can only come from a pass that ran while it did — which is
 * exactly the situation the reconciliation cases are reproducing.
 */
function seed(options: SeedOptions & SeedFiles = {}): string {
  const id = randomUUID();
  seedRow(store, sqlite, id, options);
  const dir = makeDir(id);
  const mp3 = options.mp3 ?? 'good';
  writeFileSync(
    join(dir, 'song.mp3'),
    mp3 === 'good' || mp3 === 'none' ? toneMp3 : damageMp3(toneMp3, mp3),
  );
  if (options.m4a === 'good') writeFileSync(join(dir, 'song.m4a'), goodM4a);
  if (options.m4a === 'junk') writeFileSync(join(dir, 'song.m4a'), 'not audio');
  if (options.backup !== undefined) {
    mkdirSync(migrationBackupDir(), { recursive: true });
    writeFileSync(
      join(migrationBackupDir(), `${id}.mp3`),
      options.backup === 'same' ? toneMp3 : options.backup,
    );
  }
  scanAudioMigration(sqlite);
  if (mp3 === 'none') rmSync(join(dir, 'song.mp3'));
  return id;
}

/** An orphan: files but no library row. */
function seedOrphan(): string {
  const id = randomUUID();
  writeFileSync(join(makeDir(id), 'song.mp3'), toneMp3);
  scanAudioMigration(sqlite);
  return id;
}

const row = (handle: BetterSqlite3.Database, id: string): LedgerRow =>
  getLedgerRow(handle, id) as LedgerRow;

/** Put the ledger row where a crash would have left it, then step. */
async function step(id: string, state: LedgerUpdate = {}): Promise<StepResult> {
  if (Object.keys(state).length > 0) updateLedgerRow(sqlite, id, state);
  return await stepObject(context(), row(sqlite, id));
}

const songFile = (id: string, name: string) => join(songsDir(), id, name);
const backupFile = (id: string) => join(migrationBackupDir(), `${id}.mp3`);
const has = (path: string) => existsSync(path);

// ─── Forward paths (§3.2-7) ────────────────────────────

describe('a rebuildable song', () => {
  it('converts, then deletes the mp3', async () => {
    const id = seed();
    expect(await step(id)).toEqual({ kind: 'settled', status: 'done' });

    expect(has(songFile(id, 'song.mp3'))).toBe(false);
    expect(statSync(songFile(id, 'song.m4a')).size).toBeGreaterThan(0);
    expect(has(backupFile(id))).toBe(false);
    // The success path needs no probe: the m4a holds the content.
    expect(probeCalls).toEqual([]);
  }, 60_000);

  it('discards an unreadable mp3 only after the source answers', async () => {
    const id = seed({ mp3: 'unreadable', key: 'BV1discard:9' });
    liveSources.add('BV1discard:9');

    expect(await step(id)).toEqual({ kind: 'settled', status: 'lost' });
    expect(probeCalls).toEqual(['BV1discard:9']);
    expect(has(songFile(id, 'song.mp3'))).toBe(false);
    expect(has(backupFile(id))).toBe(false);
  }, 60_000);

  it('keeps an unreadable mp3 when the source does not answer', async () => {
    const id = seed({ mp3: 'unreadable', key: 'BV1gone:9' });

    expect(await step(id)).toEqual({ kind: 'settled', status: 'kept_unconverted' });
    expect(has(songFile(id, 'song.mp3'))).toBe(false);
    expect(has(backupFile(id))).toBe(true);
    expect(getLedgerRow(sqlite, id)?.backup_path).toBe(`migration-backup/${id}.mp3`);
  }, 60_000);

  it('keeps it when the probe itself fails — no network is not permission', async () => {
    const id = seed({ mp3: 'unreadable' });
    const ctx = { ...context(), canRedownload: async () => Promise.reject(new Error('offline')) };

    const result = await stepObject(ctx, row(sqlite, id));
    expect(result).toEqual({ kind: 'settled', status: 'kept_unconverted' });
    expect(has(backupFile(id))).toBe(true);
  }, 60_000);

  // 附表 A.4: ffmpeg exits 0 on this one and writes a valid m4a holding half
  // the song. Only the duration check stands between that and a deleted mp3.
  it('treats a silently truncated conversion as unreadable, not as success', async () => {
    const id = seed({ mp3: 'truncated', key: 'BV1short:9' });

    expect(await step(id)).toEqual({ kind: 'settled', status: 'kept_unconverted' });
    expect(probeCalls).toEqual(['BV1short:9']);
    expect(has(backupFile(id))).toBe(true);
  }, 60_000);
});

describe('an asset', () => {
  it('converts, and its original ends up in the backup before it is done', async () => {
    const id = seed({ origin: 'imported' });
    expect(await step(id)).toEqual({ kind: 'settled', status: 'done' });

    expect(has(songFile(id, 'song.mp3'))).toBe(false);
    expect(has(songFile(id, 'song.m4a'))).toBe(true);
    expect(readFileSync(backupFile(id)).equals(toneMp3)).toBe(true);
    expect(getLedgerRow(sqlite, id)?.backup_path).toBe(`migration-backup/${id}.mp3`);
  }, 60_000);

  it('never asks whether the source is alive — the answer would not matter', async () => {
    const id = seed({ origin: 'imported', mp3: 'unreadable' });
    expect(await step(id)).toEqual({ kind: 'settled', status: 'kept_unconverted' });
    expect(probeCalls).toEqual([]);
    expect(readFileSync(backupFile(id)).length).toBeGreaterThan(0);
  }, 60_000);

  it('counts a song with no source at all as an asset', async () => {
    const id = seed({ key: null, mp3: 'unreadable' });
    expect(await step(id)).toEqual({ kind: 'settled', status: 'kept_unconverted' });
    expect(has(backupFile(id))).toBe(true);
  }, 60_000);
});

describe('an orphan', () => {
  it('is parked in the backup rather than converted', async () => {
    const id = seedOrphan();
    expect(await step(id)).toEqual({ kind: 'settled', status: 'kept_unconverted' });

    expect(has(songFile(id, 'song.mp3'))).toBe(false);
    expect(has(songFile(id, 'song.m4a'))).toBe(false);
    expect(has(join(migrationBackupDir(), 'orphans', `${id}.mp3`))).toBe(true);
  }, 60_000);
});

// ─── The reconciliation table (§3.2-9) ─────────────────

describe('resuming a converting row', () => {
  it('mp3 there, valid m4a there → finishes without converting again', async () => {
    const id = seed({ m4a: 'good' });
    const before = readFileSync(songFile(id, 'song.m4a'));

    expect(await step(id, { status: 'converting' })).toEqual({
      kind: 'settled',
      status: 'done',
    });
    expect(readFileSync(songFile(id, 'song.m4a')).equals(before)).toBe(true);
    expect(has(songFile(id, 'song.mp3'))).toBe(false);
  }, 60_000);

  it('mp3 there, invalid m4a there → throws it away and converts again', async () => {
    const id = seed({ m4a: 'junk' });

    expect(await step(id, { status: 'converting' })).toEqual({
      kind: 'settled',
      status: 'done',
    });
    expect(readFileSync(songFile(id, 'song.m4a')).length).toBeGreaterThan(100);
  }, 60_000);

  it('mp3 gone, valid m4a → done for a rebuildable song', async () => {
    const id = seed({ mp3: 'none', m4a: 'good' });
    expect(await step(id, { status: 'converting' })).toEqual({
      kind: 'settled',
      status: 'done',
    });
  }, 60_000);

  it('mp3 gone, no m4a → lost for a rebuildable song', async () => {
    const id = seed({ mp3: 'none' });
    expect(await step(id, { status: 'converting' })).toEqual({
      kind: 'settled',
      status: 'lost',
    });
  }, 60_000);

  // The rule that outranks a perfectly good conversion: an asset's original is
  // not replaceable BY that conversion, so losing it is reported even when the
  // m4a is fine.
  it('mp3 gone, valid m4a, no backup → asset_missing for an asset, never done', async () => {
    const id = seed({ origin: 'imported', mp3: 'none', m4a: 'good' });
    expect(await step(id, { status: 'converting' })).toEqual({
      kind: 'settled',
      status: 'asset_missing',
    });
  }, 60_000);

  it('mp3 gone, valid m4a, backup present → done for an asset', async () => {
    const id = seed({ origin: 'imported', mp3: 'none', m4a: 'good', backup: 'same' });
    expect(await step(id, { status: 'converting' })).toEqual({
      kind: 'settled',
      status: 'done',
    });
  }, 60_000);

  it('mp3 gone, no m4a, backup present → kept_unconverted for an asset', async () => {
    const id = seed({ origin: 'imported', mp3: 'none', backup: 'same' });
    expect(await step(id, { status: 'converting' })).toEqual({
      kind: 'settled',
      status: 'kept_unconverted',
    });
  }, 60_000);
});

describe('resuming a backing_up row', () => {
  it('moves the mp3 when the backup is not there yet', async () => {
    const id = seed({ origin: 'imported', m4a: 'good' });
    expect(await step(id, { status: 'backing_up', resume_state: 'done' })).toEqual({
      kind: 'settled',
      status: 'done',
    });
    expect(readFileSync(backupFile(id)).equals(toneMp3)).toBe(true);
  }, 60_000);

  it('recognises its own completed move by the bytes', async () => {
    const id = seed({ origin: 'imported', m4a: 'good', backup: 'same' });

    expect(await step(id, { status: 'backing_up', resume_state: 'done' })).toEqual({
      kind: 'settled',
      status: 'done',
    });
    expect(has(songFile(id, 'song.mp3'))).toBe(false);
    expect(readdirSync(migrationBackupDir())).toEqual([`${id}.mp3`]);
  }, 60_000);

  // Two different files under one name: neither is deleted, and the report
  // says where the second one went.
  it('parks the mp3 beside a backup that holds something else', async () => {
    const id = seed({ origin: 'imported', m4a: 'good', backup: Buffer.from('a different song') });

    expect(await step(id, { status: 'backing_up', resume_state: 'done' })).toEqual({
      kind: 'settled',
      status: 'done',
    });
    expect(readFileSync(backupFile(id), 'utf-8')).toBe('a different song');
    expect(readFileSync(join(migrationBackupDir(), `${id}.reconcile-1.mp3`)).equals(toneMp3)).toBe(
      true,
    );
    expect(getLedgerRow(sqlite, id)?.reconcile_action).toContain('reconcile-1');
  }, 60_000);

  it('reports asset_missing when neither the mp3 nor a backup is there', async () => {
    const id = seed({ origin: 'imported', mp3: 'none' });
    expect(await step(id, { status: 'backing_up', resume_state: 'kept_unconverted' })).toEqual({
      kind: 'settled',
      status: 'asset_missing',
    });
  }, 60_000);
});

describe('resuming a discarding row', () => {
  // The probe already happened — that is the entire reason this status
  // exists, and re-running it would ask the network again on every boot.
  it('deletes the mp3 without probing again', async () => {
    const id = seed();
    expect(await step(id, { status: 'discarding' })).toEqual({
      kind: 'settled',
      status: 'lost',
    });
    expect(probeCalls).toEqual([]);
    expect(has(songFile(id, 'song.mp3'))).toBe(false);
  }, 60_000);
});

describe('an object that is already finished', () => {
  it('is left alone when nothing came back', async () => {
    const id = seed({ mp3: 'none' });
    expect(await step(id, { status: 'done' })).toEqual({ kind: 'skipped' });
  }, 60_000);

  // Somebody restored a backup, or copied files in. The mp3 is not deleted and
  // the object does not reopen — but songs/ still has to end up clean.
  it('moves a reappeared mp3 to the backup instead of deleting it', async () => {
    const id = seed({ m4a: 'good' });
    expect(await step(id, { status: 'done' })).toEqual({ kind: 'settled', status: 'done' });

    expect(has(songFile(id, 'song.mp3'))).toBe(false);
    expect(readFileSync(backupFile(id)).equals(toneMp3)).toBe(true);
    expect(getLedgerRow(sqlite, id)?.reconcile_action).toContain('迁移完成后');
  }, 60_000);
});

describe('a sync file op still owns the directory', () => {
  it('is skipped without touching anything', async () => {
    const id = seed();
    expect(await step(id, { status: 'blocked_file_op' })).toEqual({ kind: 'skipped' });
    expect(has(songFile(id, 'song.mp3'))).toBe(true);
  }, 60_000);
});

// ─── Failures ──────────────────────────────────────────

describe('when a file action fails', () => {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(asRoot)(
    'blocks the object and records the action',
    async () => {
      // A conversion that already landed, so the only thing left is the
      // unlink — inside a directory that has just become read-only.
      const id = seed({ m4a: 'good' });
      const dir = join(songsDir(), id);
      chmodSync(dir, 0o500);

      const result = await stepObject(context(), row(sqlite, id));
      expect(result.kind).toBe('blocked');
      expect(getLedgerRow(sqlite, id)).toMatchObject({
        status: 'blocked',
        blocked_action: 'unlink_mp3',
        error_class: 'file_action',
      });
      expect(has(songFile(id, 'song.mp3'))).toBe(true);

      // The retry re-reads the disk rather than replaying the recorded action:
      // the disk is the state, and it cannot be out of date with itself.
      chmodSync(dir, 0o700);
      expect(await stepObject(context(), row(sqlite, id))).toEqual({
        kind: 'settled',
        status: 'done',
      });
      expect(has(songFile(id, 'song.mp3'))).toBe(false);
    },
    60_000,
  );
});

describe('when the machine is the problem', () => {
  it('stops the pass and leaves the mp3 exactly where it was', async () => {
    const id = seed();
    const broken = {
      ...context(),
      tools: { ...tools, ffprobe: { ...tools.ffprobe, path: join(nest, 'no-such-ffprobe') } },
    };

    const result = await stepObject(broken, row(sqlite, id));
    expect(result.kind).toBe('environment');
    expect(has(songFile(id, 'song.mp3'))).toBe(true);
    expect(has(songFile(id, 'song.m4a'))).toBe(false);
    // Back to pending, so the retry after the machine is fixed is a no-op to
    // arrange: the row is queued and the disk is untouched.
    expect(getLedgerRow(sqlite, id)).toMatchObject({
      status: 'pending',
      error_class: 'environment',
    });
  }, 60_000);

  it('leaves the row pending and the file untouched when cancelled', async () => {
    const id = seed();
    const controller = new AbortController();
    controller.abort();

    const result = await stepObject({ ...context(), signal: controller.signal }, row(sqlite, id));
    expect(result).toEqual({ kind: 'aborted' });
    expect(has(songFile(id, 'song.mp3'))).toBe(true);
    expect(getLedgerRow(sqlite, id)).toMatchObject({ status: 'pending', error_class: 'abort' });
  }, 60_000);

  // The half-written output of the cancelled run must not be mistaken for a
  // conversion by the next one.
  it('sweeps its own temp file before starting over', async () => {
    const id = seed();
    writeFileSync(join(songsDir(), id, '.song.migration.m4a.tmp'), 'half a conversion');

    expect(await step(id)).toEqual({ kind: 'settled', status: 'done' });
    expect(readdirSync(join(songsDir(), id))).toEqual(['song.m4a']);
  }, 60_000);
});
