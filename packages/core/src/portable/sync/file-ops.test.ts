import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../db/index.js';
import { songAudioPath, songLyricsPath } from '../../paths.js';
import { recoveredSongsDir, songsDir } from '../../paths.js';
// The suite stays whole across N1b's split: what it tests is the journal's
// end-to-end contract — a decision written down in a transaction, then made
// true on disk — and that contract is the pair, not either half.
import {
  FileEffectRuntime,
  countQuarantined,
  pruneEmptyQuarantines,
} from '../../sync/file-ops-runtime.js';
import { ClaimRegistry } from '../download/claims.js';
import { FileOpBusyError, FileOpNotFoundError } from '../errors.js';
import { emitSyncChange, recordDeadLetter } from './changes.js';
import {
  countFileOps,
  enqueueDeleteLyrics,
  enqueueLocalDelete,
  enqueueQuarantine,
  enqueueRemoteDelete,
  enqueueWriteLyrics,
  listFileOps,
  pendingFileOpSongIds,
} from './file-ops.js';

let nest: string;
let sqlite: BetterSqlite3.Database;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-file-ops-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

function seedSong(id: string, options: { audio?: boolean; lyrics?: boolean } = {}): void {
  const dir = join(songsDir(), id);
  mkdirSync(dir, { recursive: true });
  if (options.audio !== false) writeFileSync(songAudioPath(id), 'audio');
  if (options.lyrics) writeFileSync(songLyricsPath(id), '[00:00.00]hi');
}

function quarantineOf(id: string): string[] {
  const root = recoveredSongsDir();
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.startsWith(id));
}

function runtime(options: { claims?: ClaimRegistry; owner?: string; now?: () => number } = {}) {
  return new FileEffectRuntime({
    sqlite,
    claims: options.claims,
    owner: options.owner,
    nowMs: options.now,
  });
}

describe('enqueue snapshots the decision', () => {
  it('quarantines lyrics that are still only here (R4-3)', () => {
    const id = randomUUID();
    emitSyncChange(sqlite, {
      entityType: 'song',
      entityId: id,
      op: 'set_lyrics',
      payload: { lrc: '[00:01.00]unpublished' },
    });

    enqueueRemoteDelete(sqlite, id, 'downloaded');

    const arg = JSON.parse(
      (sqlite.prepare('SELECT arg FROM sync_file_ops').get() as { arg: string }).arg,
    );
    // The executor cannot tell "small file" from "the only copy in the world",
    // so the decision is made here, while the outbox is still readable.
    expect(arg.lyrics_disposition).toBe('quarantine');
    expect(arg.audio_origin).toBe('downloaded');
    expect(arg.quarantine_target).toContain(id);
  });

  it('quarantines lyrics that were archived as too large to push', () => {
    const id = randomUUID();
    recordDeadLetter(sqlite, {
      direction: 'out',
      reason: 'change_too_large',
      entityType: 'song',
      entityId: id,
      op: 'set_lyrics',
    });

    enqueueRemoteDelete(sqlite, id, 'downloaded');
    const arg = JSON.parse(
      (sqlite.prepare('SELECT arg FROM sync_file_ops').get() as { arg: string }).arg,
    );
    expect(arg.lyrics_disposition).toBe('quarantine');
  });

  it('deletes lyrics that the server already has', () => {
    const id = randomUUID();
    const cid = emitSyncChange(sqlite, {
      entityType: 'song',
      entityId: id,
      op: 'set_lyrics',
      payload: { lrc: '[00:01.00]pushed' },
    });
    sqlite.prepare('UPDATE sync_changes SET synced_at = 1 WHERE client_change_id = ?').run(cid);

    enqueueRemoteDelete(sqlite, id, 'downloaded');
    const arg = JSON.parse(
      (sqlite.prepare('SELECT arg FROM sync_file_ops').get() as { arg: string }).arg,
    );
    expect(arg.lyrics_disposition).toBe('delete');
  });
});

describe('executing a delete', () => {
  it('takes the whole directory for a local delete', async () => {
    const id = randomUUID();
    seedSong(id, { lyrics: true });
    enqueueLocalDelete(sqlite, id);

    expect(await runtime().drain()).toEqual({ executed: 1, failed: 0, skipped: 0 });
    expect(existsSync(join(songsDir(), id))).toBe(false);
    expect(countQuarantined()).toBe(0);
  });

  it('deletes replaceable audio and keeps what only exists here', async () => {
    const downloaded = randomUUID();
    const imported = randomUUID();
    const unknown = randomUUID();
    seedSong(downloaded);
    seedSong(imported);
    seedSong(unknown);

    enqueueRemoteDelete(sqlite, downloaded, 'downloaded');
    enqueueRemoteDelete(sqlite, imported, 'imported');
    // A Go-migrated song has no source at all — the conservative reading is
    // the only safe one.
    enqueueRemoteDelete(sqlite, unknown, null);

    await runtime().drain();

    expect(quarantineOf(downloaded)).toHaveLength(0);
    expect(quarantineOf(imported)).toHaveLength(1);
    expect(quarantineOf(unknown)).toHaveLength(1);
    expect(countQuarantined()).toBe(2);
    for (const id of [downloaded, imported, unknown]) {
      expect(existsSync(join(songsDir(), id))).toBe(false);
    }
  });

  it('rescues pending lyrics even when the audio is replaceable', async () => {
    const id = randomUUID();
    seedSong(id, { lyrics: true });
    emitSyncChange(sqlite, {
      entityType: 'song',
      entityId: id,
      op: 'set_lyrics',
      payload: { lrc: '[00:01.00]unpublished' },
    });
    enqueueRemoteDelete(sqlite, id, 'downloaded');

    await runtime().drain();

    const [dir] = quarantineOf(id);
    expect(dir).toBeDefined();
    const rescued = join(recoveredSongsDir(), dir);
    expect(existsSync(join(rescued, 'lyrics.lrc'))).toBe(true);
    expect(existsSync(join(rescued, 'song.m4a'))).toBe(false);
  });

  it('is a no-op when the files are already gone', async () => {
    const id = randomUUID();
    enqueueRemoteDelete(sqlite, id, 'imported');
    expect(await runtime().drain()).toEqual({ executed: 1, failed: 0, skipped: 0 });
    expect(countQuarantined()).toBe(0);
  });

  // An op written by 0.2.x has no `audio_file` in its snapshot and a song.mp3
  // on disk. The boot drain runs it BEFORE the audio migration, so this is a
  // real sequence, and getting it wrong is not cosmetic: the executor removes
  // the directory right after, so an unrecognised name deletes an imported
  // song instead of rescuing it.
  it('rescues a 0.2.x song.mp3 for an op that predates the file name', async () => {
    const id = randomUUID();
    const dir = join(songsDir(), id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'song.mp3'), 'imported audio');

    enqueueRemoteDelete(sqlite, id, 'imported');
    // Strip the field the way a v0.2 row would have been written.
    const row = sqlite.prepare('SELECT id, arg FROM sync_file_ops').get() as {
      id: number;
      arg: string;
    };
    const legacy = JSON.parse(row.arg) as Record<string, unknown>;
    legacy.audio_file = undefined;
    sqlite
      .prepare('UPDATE sync_file_ops SET arg = ? WHERE id = ?')
      .run(JSON.stringify(legacy), row.id);

    await runtime().drain();

    const [target] = quarantineOf(id);
    expect(target).toBeDefined();
    expect(readFileSync(join(recoveredSongsDir(), target, 'song.mp3'), 'utf-8')).toBe(
      'imported audio',
    );
    expect(existsSync(dir)).toBe(false);
  });
});

describe('executing the other kinds', () => {
  it('moves a directory aside, and recognises a rerun by the target', async () => {
    const id = randomUUID();
    seedSong(id, { lyrics: true });
    enqueueQuarantine(sqlite, id);
    await runtime().drain();
    expect(countQuarantined()).toBe(1);

    // Second op, same song, new target: the directory is gone, so there is
    // nothing to move and nothing to fail about.
    seedSong(id);
    enqueueQuarantine(sqlite, id);
    await runtime().drain();
    expect(countQuarantined()).toBe(2);
  });

  it('writes lyrics, and treats a blank document as their absence', async () => {
    const id = randomUUID();
    seedSong(id);
    enqueueWriteLyrics(sqlite, id, '[00:02.00]from a peer');
    await runtime().drain();
    expect(readFileSync(songLyricsPath(id), 'utf-8')).toBe('[00:02.00]from a peer');

    enqueueWriteLyrics(sqlite, id, '   ');
    await runtime().drain();
    // "No lyrics" is the file not being there; a zero-byte file would read as
    // lyrics that exist and say nothing.
    expect(existsSync(songLyricsPath(id))).toBe(false);
  });

  it('counts deleting absent lyrics as success', async () => {
    const id = randomUUID();
    seedSong(id);
    enqueueDeleteLyrics(sqlite, id);
    expect(await runtime().drain()).toEqual({ executed: 1, failed: 0, skipped: 0 });
  });
});

describe('ordering and failure', () => {
  /** A bogus song id fails the uuid gate inside the executor, deterministically. */
  const BROKEN = 'not-a-uuid';

  it('holds one song in order while other songs overtake', async () => {
    const healthy = randomUUID();
    seedSong(healthy);
    enqueueDeleteLyrics(sqlite, BROKEN);
    enqueueDeleteLyrics(sqlite, BROKEN);
    enqueueLocalDelete(sqlite, healthy);

    const result = await runtime().drain();
    expect(result.executed).toBe(1);
    expect(result.failed).toBe(1);
    // The second broken op is not attempted: ops for one song are ordered
    // because they depend on each other.
    expect(result.skipped).toBe(1);
    expect(existsSync(join(songsDir(), healthy))).toBe(false);

    const rows = sqlite.prepare('SELECT attempts FROM sync_file_ops ORDER BY id').all() as {
      attempts: number;
    }[];
    expect(rows.map((r) => r.attempts)).toEqual([1, 0]);
  });

  it('backs off, then gives up and waits for a human', async () => {
    let now = 1_000_000;
    const rt = runtime({ now: () => now });
    enqueueDeleteLyrics(sqlite, BROKEN);

    await rt.drain();
    expect(countFileOps(sqlite)).toMatchObject({ pending: 1, failed: 0 });

    // Same millisecond: the backoff is still in the future, so the row is
    // skipped rather than burned through.
    expect(await rt.drain()).toEqual({ executed: 0, failed: 0, skipped: 1 });

    for (let i = 0; i < 4; i++) {
      now += 3_600_000;
      await rt.drain();
    }

    const counts = countFileOps(sqlite);
    expect(counts).toMatchObject({ pending: 0, failed: 1 });
    expect(counts.lastError).toContain('Invalid id');
    const row = sqlite.prepare('SELECT attempts, next_retry_at FROM sync_file_ops').get() as {
      attempts: number;
      next_retry_at: number | null;
    };
    expect(row.attempts).toBe(5);
    expect(row.next_retry_at).toBeNull();
  });

  it('skips a song another writer is holding, without counting an attempt', async () => {
    const id = randomUUID();
    seedSong(id);
    const claims = new ClaimRegistry();
    const held = claims.acquire(id, 'file', 'download-task-1');
    enqueueLocalDelete(sqlite, id);

    expect(await runtime({ claims }).drain()).toEqual({ executed: 0, failed: 0, skipped: 1 });
    expect(
      (sqlite.prepare('SELECT attempts FROM sync_file_ops').get() as { attempts: number }).attempts,
    ).toBe(0);
    expect(existsSync(join(songsDir(), id))).toBe(true);

    claims.release(held);
    expect(await runtime({ claims }).drain()).toEqual({ executed: 1, failed: 0, skipped: 0 });
  });

  it('reuses the claim of the caller that triggered it', async () => {
    const id = randomUUID();
    seedSong(id);
    const claims = new ClaimRegistry();
    // The route that just deleted the song still holds its exclusive claim; a
    // drain that fought it would deadlock against its own caller.
    claims.acquire(id, 'exclusive', 'route:delete-1');
    enqueueLocalDelete(sqlite, id);

    expect(await runtime({ claims, owner: 'route:delete-1' }).drain()).toEqual({
      executed: 1,
      failed: 0,
      skipped: 0,
    });
  });
});

describe('retry and discard', () => {
  const BROKEN = 'not-a-uuid';

  async function failPermanently(rt: FileEffectRuntime, advance: () => void): Promise<number> {
    enqueueDeleteLyrics(sqlite, BROKEN);
    for (let i = 0; i < 5; i++) {
      await rt.drain();
      advance();
    }
    return (sqlite.prepare('SELECT id FROM sync_file_ops').get() as { id: number }).id;
  }

  it('puts a failed row back in play from zero', async () => {
    let now = 1_000_000;
    const rt = runtime({ now: () => now });
    const id = await failPermanently(rt, () => {
      now += 3_600_000;
    });
    expect(countFileOps(sqlite).failed).toBe(1);

    await rt.retry(id);
    // Still broken, so it failed again — but from a clean slate, which is what
    // "I fixed the thing that was wrong" has to mean.
    const row = sqlite.prepare('SELECT attempts FROM sync_file_ops WHERE id = ?').get(id) as {
      attempts: number;
    };
    expect(row.attempts).toBe(1);
  });

  it('refuses to discard a row that has not given up yet', async () => {
    const rt = runtime();
    enqueueDeleteLyrics(sqlite, BROKEN);
    await rt.drain();
    const id = (sqlite.prepare('SELECT id FROM sync_file_ops').get() as { id: number }).id;

    expect(() => rt.discard(id)).toThrow(FileOpBusyError);
    expect(() => rt.discard(9999)).toThrow(FileOpNotFoundError);
  });

  it('archives what it abandons', async () => {
    let now = 1_000_000;
    const rt = runtime({ now: () => now });
    const id = await failPermanently(rt, () => {
      now += 3_600_000;
    });

    rt.discard(id);

    expect(sqlite.prepare('SELECT count(*) AS n FROM sync_file_ops').get()).toEqual({ n: 0 });
    const letter = sqlite
      .prepare("SELECT reason, entity_id, op, payload FROM sync_dead_letters WHERE direction='out'")
      .get() as { reason: string; entity_id: string; op: string; payload: string };
    // A discard nobody can audit later is just a deletion.
    expect(letter.reason).toBe('file_op_discarded');
    expect(letter.entity_id).toBe(BROKEN);
    expect(letter.op).toBe('delete_lyrics');
    expect(JSON.parse(letter.payload)).toMatchObject({ attempts: 5 });
  });

  it('refuses both while a drain is in flight', async () => {
    const id = randomUUID();
    seedSong(id);
    enqueueLocalDelete(sqlite, id);
    const rt = runtime();

    const inFlight = rt.drain();
    expect(rt.busy).toBe(true);
    expect(() => rt.discard(1)).toThrow(FileOpBusyError);
    await expect(rt.retry()).rejects.toBeInstanceOf(FileOpBusyError);
    await inFlight;
    expect(rt.busy).toBe(false);
  });
});

describe('the redacted list', () => {
  it('reports lyrics as a size and a digest, never as text', async () => {
    const id = randomUUID();
    const lrc = '[00:03.00]secret words';
    enqueueWriteLyrics(sqlite, id, lrc);

    const [summary] = listFileOps(sqlite);
    expect(summary.kind).toBe('write_lyrics');
    expect(summary.song_id).toBe(id);
    expect(summary.inline).toEqual({
      size: Buffer.byteLength(lrc, 'utf8'),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(listFileOps(sqlite))).not.toContain('secret words');
  });

  it('filters by state', async () => {
    let now = 1_000_000;
    const rt = runtime({ now: () => now });
    enqueueDeleteLyrics(sqlite, 'not-a-uuid');
    for (let i = 0; i < 5; i++) {
      await rt.drain();
      now += 3_600_000;
    }
    // Enqueued after the failures, so it has never run: one row in each state.
    enqueueWriteLyrics(sqlite, randomUUID(), '[00:00.00]x');

    expect(listFileOps(sqlite, 'failed').map((o) => o.kind)).toEqual(['delete_lyrics']);
    expect(listFileOps(sqlite, 'pending').map((o) => o.kind)).toEqual(['write_lyrics']);
    expect(listFileOps(sqlite)).toHaveLength(2);
  });
});

describe('housekeeping', () => {
  it('names the songs boot recovery must leave alone', () => {
    const a = randomUUID();
    const b = randomUUID();
    enqueueLocalDelete(sqlite, a);
    enqueueDeleteLyrics(sqlite, a);
    enqueueQuarantine(sqlite, b);
    expect(pendingFileOpSongIds(sqlite)).toEqual(new Set([a, b]));
  });

  it('prunes an empty quarantine directory but never a full one', async () => {
    const empty = join(recoveredSongsDir(), 'empty-dir');
    const full = join(recoveredSongsDir(), 'full-dir');
    mkdirSync(empty, { recursive: true });
    mkdirSync(full, { recursive: true });
    writeFileSync(join(full, 'song.m4a'), 'audio');

    expect(await pruneEmptyQuarantines()).toBe(1);
    expect(existsSync(empty)).toBe(false);
    expect(existsSync(full)).toBe(true);
  });
});
