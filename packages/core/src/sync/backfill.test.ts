import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYNC_CHANGE_BYTES_MAX } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DatabaseHandles, createDatabase } from '../db/index.js';
import { songLyricsPath } from '../library/lyrics.js';
import { createPlaylist } from '../library/playlists.js';
import { addSongsToPlaylist } from '../library/playlists.js';
import { createSong } from '../library/songs.js';
import { songsDir } from '../paths.js';
import {
  backfillOwed,
  bumpBackfillTarget,
  preReadLyrics,
  readBackfillGenerations,
  runFullBackfill,
  runFullBackfillInTx,
} from './backfill.js';
import { emitSyncChange } from './changes.js';

let nest: string;
let handles: DatabaseHandles;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-backfill-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  handles = createDatabase({ dbPath: ':memory:' });
});

afterEach(() => {
  handles.sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const sq = () => handles.sqlite;
const store = () => handles.portable;

const ops = (sqlite: BetterSqlite3.Database = sq()) =>
  (
    sqlite
      .prepare('SELECT entity_type, entity_id, op, payload FROM sync_changes ORDER BY local_seq')
      .all() as { entity_type: string; entity_id: string; op: string; payload: string }[]
  ).map((c) => ({ ...c, label: `${c.entity_type}.${c.op}` }));

/**
 * A library that predates sync: rows inserted the way `migrate-go` and v0.1
 * made them — no change rows anywhere.
 */
function seedPreSyncLibrary(): { songId: string; playlistId: string } {
  const songId = randomUUID();
  const playlistId = randomUUID();
  sq()
    .prepare(
      `INSERT INTO songs (id, name, artist, source_provider, source_key, file_origin,
         created_at, updated_at, lww_counter)
       VALUES (?, '旧歌', '旧手', 'bilibili', 'BVold:1', 'imported', 1000, 1000, 0)`,
    )
    .run(songId);
  sq()
    .prepare(
      `INSERT INTO playlists (id, name, created_at, updated_at, lww_counter)
       VALUES (?, '旧单', 2000, 2000, 0)`,
    )
    .run(playlistId);
  sq()
    .prepare(
      `INSERT INTO playlist_songs (playlist_id, song_id, rank, added_at, updated_at, lww_counter)
       VALUES (?, ?, 1024, 3000, 3000, 0)`,
    )
    .run(playlistId, songId);
  return { songId, playlistId };
}

function writeLyricsFileFor(songId: string, text: string): void {
  mkdirSync(join(songsDir(), songId), { recursive: true });
  writeFileSync(songLyricsPath(songId), text);
}

describe('generations', () => {
  it('starts owed, is settled by a run, and is owed again after an unbind', async () => {
    expect(readBackfillGenerations(sq())).toEqual({ done: 0, target: 1 });
    expect(backfillOwed(sq())).toBe(true);

    await runFullBackfill(sq());
    expect(backfillOwed(sq())).toBe(false);

    bumpBackfillTarget(sq());
    // unbind threw the outbox away, so the next binding has to republish
    // everything — that is what the counter is for.
    expect(readBackfillGenerations(sq())).toEqual({ done: 1, target: 2 });
    expect(backfillOwed(sq())).toBe(true);
  });
});

describe('runFullBackfill', () => {
  it('publishes a library that has never emitted anything', async () => {
    const { songId, playlistId } = seedPreSyncLibrary();
    writeLyricsFileFor(songId, '[00:01.00]旧词');

    const result = await runFullBackfill(sq());

    expect(result).toMatchObject({ songs: 1, playlists: 1, memberships: 1, lyrics: 1 });
    expect(ops().map((c) => c.label)).toEqual([
      'song.create',
      'playlist.create',
      'playlist_song.create',
      'playlist_song.set_rank',
      'song.set_lyrics',
    ]);
    // Parents before children, and the membership pair keeps rank out of the
    // put exactly as an ordinary add does (R4-2).
    const membership = ops().find((c) => c.label === 'playlist_song.create');
    expect(JSON.parse(membership?.payload ?? '{}')).not.toHaveProperty('rank');
    expect(
      JSON.parse(ops().find((c) => c.label === 'playlist_song.set_rank')?.payload ?? '{}'),
    ).toEqual({ rank: 1024 });
    expect(membership?.entity_id).toBe(`${playlistId}:${songId}`);

    const songCreate = ops().find((c) => c.label === 'song.create');
    expect(JSON.parse(songCreate?.payload ?? '{}')).toMatchObject({
      name: '旧歌',
      source_key: 'BVold:1',
      created_at_ms: 1000,
      updated_at_ms: 1000,
    });
  });

  it('never publishes a second create for what the write paths already emitted', async () => {
    const song = createSong(store(), { name: '新歌' });
    const playlist = createPlaylist(store(), '新单');
    addSongsToPlaylist(store(), playlist.id, [song.id]);
    const before = ops().length;

    const result = await runFullBackfill(sq());

    expect(result).toMatchObject({ songs: 0, playlists: 0, memberships: 0 });
    expect(ops()).toHaveLength(before);
  });

  it('is safe to run twice', async () => {
    seedPreSyncLibrary();
    await runFullBackfill(sq());
    const after = ops().length;
    await runFullBackfill(sq());
    expect(ops()).toHaveLength(after);
  });

  it('archives lyrics too large to ever push, and keeps going', async () => {
    const { songId } = seedPreSyncLibrary();
    writeLyricsFileFor(songId, `[00:01.00]${'x'.repeat(SYNC_CHANGE_BYTES_MAX)}`);

    const result = await runFullBackfill(sq());

    expect(result).toMatchObject({ songs: 1, lyrics: 0, lyricsOversize: 1 });
    expect(ops().some((c) => c.label === 'song.set_lyrics')).toBe(false);
    expect(
      sq().prepare("SELECT reason FROM sync_dead_letters WHERE direction='out'").get(),
    ).toEqual({ reason: 'change_too_large' });
  });

  it('reads no lyrics for a song that has none', async () => {
    seedPreSyncLibrary();
    const snapshot = await preReadLyrics(sq());
    expect(snapshot.size).toBe(0);
  });
});

describe('the stale-lyrics window (R5-2)', () => {
  it('drops the snapshot when a newer lyrics change is already waiting', async () => {
    const { songId } = seedPreSyncLibrary();
    writeLyricsFileFor(songId, '[00:01.00]L1');

    // The read happens outside the transaction, so this is the real sequence:
    // pre-read L1 → a lyrics task writes L2 and emits it → the transaction
    // opens. Emitting the snapshot here would push L1 over L2 with a HIGHER
    // local_seq, and the newer document would lose on every device.
    const snapshot = await preReadLyrics(sq());
    writeLyricsFileFor(songId, '[00:02.00]L2');
    emitSyncChange(sq(), {
      entityType: 'song',
      entityId: songId,
      op: 'set_lyrics',
      payload: { lrc: '[00:02.00]L2' },
    });

    const result = sq()
      .transaction(() => runFullBackfillInTx(sq(), snapshot))
      .immediate();

    expect(result).toMatchObject({ lyrics: 0, lyricsSkipped: 1 });
    const lyricsOps = ops().filter((c) => c.label === 'song.set_lyrics');
    expect(lyricsOps).toHaveLength(1);
    expect(JSON.parse(lyricsOps[0].payload)).toEqual({ lrc: '[00:02.00]L2' });
  });

  it('drops the snapshot when the lyrics were already archived as unpushable', async () => {
    const { songId } = seedPreSyncLibrary();
    writeLyricsFileFor(songId, '[00:01.00]L1');
    const snapshot = await preReadLyrics(sq());
    sq()
      .prepare(
        `INSERT INTO sync_dead_letters (direction, entity_type, entity_id, op, reason, recorded_at)
         VALUES ('out', 'song', ?, 'set_lyrics', 'change_too_large', 1)`,
      )
      .run(songId);

    const result = sq()
      .transaction(() => runFullBackfillInTx(sq(), snapshot))
      .immediate();

    // Re-emitting would just fail the same way, and the archive already says
    // this song's lyrics are not going anywhere.
    expect(result).toMatchObject({ lyrics: 0, lyricsSkipped: 1 });
  });
});
