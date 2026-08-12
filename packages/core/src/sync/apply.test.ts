import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { membershipEntityId } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DatabaseHandles, createDatabase } from '../db/index.js';
import {
  addSongsToPlaylist,
  createPlaylist,
  removeSongFromPlaylist,
} from '../library/playlists.js';
import { RANK_STEP } from '../library/rank.js';
import { createSong, deleteSong } from '../library/songs.js';
import { type InboundChange, applyChangesInTx } from './apply.js';
import { listConflicts } from './conflicts.js';
import { readTombstone } from './tombstones.js';

let nest: string;
let handles: DatabaseHandles;
let seq = 0;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-apply-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  handles = createDatabase({ dbPath: ':memory:' });
  seq = 0;
});

afterEach(() => {
  handles.sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const db = () => handles.db;
const sq = () => handles.sqlite;

function change(
  entity_type: string,
  entity_id: string,
  op: string,
  payload: unknown,
  overrides: Partial<InboundChange> = {},
): InboundChange {
  seq += 1;
  return {
    server_seq: seq,
    device_id: 'peer-1',
    client_change_id: randomUUID(),
    entity_type,
    entity_id,
    op,
    payload,
    client_local_seq: seq,
    client_created_at: 1000 + seq,
    server_received_at: 2000 + seq,
    ...overrides,
  };
}

const apply = (...changes: InboundChange[]) =>
  sq()
    .transaction(() => applyChangesInTx(sq(), changes))
    .immediate();

const songPayload = (overrides: Record<string, unknown> = {}) => ({
  name: '远端的歌',
  artist: '远端',
  source_url: null,
  source_provider: null,
  source_key: null,
  lyrics_offset: 0,
  duration: 100,
  created_at_ms: 1000,
  updated_at_ms: 5000,
  lww_counter: 0,
  ...overrides,
});

const playlistPayload = (overrides: Record<string, unknown> = {}) => ({
  name: '远端歌单',
  created_at_ms: 1000,
  updated_at_ms: 5000,
  lww_counter: 0,
  ...overrides,
});

const songRow = (id: string) =>
  sq().prepare('SELECT * FROM songs WHERE id = ?').get(id) as Record<string, unknown> | undefined;

const members = (playlistId: string) =>
  sq()
    .prepare(
      'SELECT song_id, rank FROM playlist_songs WHERE playlist_id = ? ORDER BY rank, song_id',
    )
    .all(playlistId) as { song_id: string; rank: number }[];

const journal = () =>
  sq().prepare('SELECT kind, song_id, arg FROM sync_file_ops ORDER BY id').all() as {
    kind: string;
    song_id: string;
    arg: string;
  }[];

/** Mark this device's own pending change as accepted, so its echo can come back. */
function markSynced(cid: string): void {
  sq().prepare('UPDATE sync_changes SET synced_at = 1 WHERE client_change_id = ?').run(cid);
}

const lastCid = (entityId: string, op: string): string =>
  (
    sq()
      .prepare(
        'SELECT client_change_id FROM sync_changes WHERE entity_id = ? AND op = ? ORDER BY local_seq DESC LIMIT 1',
      )
      .get(entityId, op) as { client_change_id: string }
  ).client_change_id;

describe('song puts', () => {
  it('inserts a song this device has never seen', () => {
    const id = randomUUID();
    const result = apply(change('song', id, 'create', songPayload()));

    expect(result).toMatchObject({ applied: 1, skipped: 0, songsTouched: true });
    expect(songRow(id)).toMatchObject({
      name: '远端的歌',
      created_at: 1000,
      updated_at: 5000,
      device_id: 'peer-1',
      // Local truth, not the workspace's: there is no file here yet, and
      // whatever this device ends up with, it got by downloading.
      file_origin: 'downloaded',
      pinned: 0,
    });
  });

  it('takes an update for a row that is missing, but never one for a deleted song', async () => {
    const id = randomUUID();
    apply(change('song', id, 'update', songPayload({ name: '补回来' })));
    expect(songRow(id)).toMatchObject({ name: '补回来' });

    const gone = createSong(db(), sq(), { name: '本地删掉' });
    await deleteSong(db(), sq(), gone.id);
    const result = apply(change('song', gone.id, 'create', songPayload({ updated_at_ms: 9e12 })));

    // A song's delete is final. Even a much newer create is a stale echo.
    expect(result).toMatchObject({ applied: 0, skipped: 1 });
    expect(songRow(gone.id)).toBeUndefined();
  });

  it('never lets created_at move', () => {
    const id = randomUUID();
    apply(change('song', id, 'create', songPayload({ created_at_ms: 1000 })));
    apply(change('song', id, 'update', songPayload({ created_at_ms: 7777, updated_at_ms: 6000 })));

    // Two devices that "created the same song" at different moments would
    // otherwise flip this forever.
    expect(songRow(id)).toMatchObject({ created_at: 1000, updated_at: 6000 });
  });

  it('keeps the local row when the incoming key is older', () => {
    const song = createSong(db(), sq(), { name: '本地新' });
    const before = songRow(song.id);

    const result = apply(
      change('song', song.id, 'update', songPayload({ name: '远端旧', updated_at_ms: 1 })),
    );

    expect(result).toMatchObject({ applied: 0, skipped: 1 });
    expect(songRow(song.id)).toEqual(before);
  });

  it('skips our own accepted change coming back', () => {
    const song = createSong(db(), sq(), { name: '我的' });
    const cid = lastCid(song.id, 'create');
    markSynced(cid);

    const result = apply(
      change('song', song.id, 'create', songPayload({ name: '回声', updated_at_ms: 9e12 }), {
        client_change_id: cid,
      }),
    );

    // Re-applying it would restore a version this device may have superseded
    // locally since it was pushed.
    expect(result).toMatchObject({ applied: 0, skipped: 1 });
    expect(songRow(song.id)).toMatchObject({ name: '我的' });
  });

  it('converges on the same state whichever order two duplicates arrive in (D8)', () => {
    const a = randomUUID();
    const b = randomUUID();
    const payloadA = songPayload({
      name: '甲',
      source_provider: 'bilibili',
      source_key: 'BVdup:1',
    });
    const payloadB = songPayload({
      name: '乙',
      source_provider: 'bilibili',
      source_key: 'BVdup:1',
    });

    apply(change('song', a, 'create', payloadA), change('song', b, 'create', payloadB));
    const forward = sq().prepare('SELECT id, name FROM songs ORDER BY id').all() as {
      id: string;
      name: string;
    }[];

    sq().prepare('DELETE FROM songs').run();
    apply(change('song', b, 'create', payloadB), change('song', a, 'create', payloadA));
    const backward = sq().prepare('SELECT id, name FROM songs ORDER BY id').all() as {
      id: string;
      name: string;
    }[];

    // Both songs land, both times: the duplicate is visible rather than an
    // apply that can never succeed.
    expect(forward).toHaveLength(2);
    expect(backward).toEqual(forward);
  });
});

describe('song deletes', () => {
  it('removes the row, records the tombstone and queues the file effect', () => {
    const song = createSong(db(), sq(), { name: '要被远端删掉' });
    sq().prepare("UPDATE songs SET file_origin='imported' WHERE id = ?").run(song.id);

    const result = apply(
      change('song', song.id, 'delete', { updated_at_ms: 9e12, lww_counter: 0 }),
    );

    expect(result).toMatchObject({ applied: 1, fileOps: 1 });
    expect(songRow(song.id)).toBeUndefined();
    expect(readTombstone(sq(), 'song', song.id)).not.toBeNull();
    const [op] = journal();
    expect(op.kind).toBe('delete_song_files');
    // The origin is snapshotted while the row is still there; the executor has
    // nothing left to read by the time it runs.
    expect(JSON.parse(op.arg)).toMatchObject({ policy: 'remote', audio_origin: 'imported' });
  });

  it('records a tombstone for a song it never had', () => {
    const id = randomUUID();
    apply(change('song', id, 'delete', { updated_at_ms: 5000, lww_counter: 0 }));

    // Without this, a `create` arriving later out of order would resurrect it.
    expect(readTombstone(sq(), 'song', id)).not.toBeNull();
    expect(JSON.parse(journal()[0].arg)).toMatchObject({ audio_origin: null });
  });

  it('cascades memberships without emitting or entombing them', () => {
    const song = createSong(db(), sq(), { name: 's' });
    const playlist = createPlaylist(db(), sq(), 'p');
    addSongsToPlaylist(db(), sq(), playlist.id, [song.id]);

    apply(change('song', song.id, 'delete', { updated_at_ms: 9e12, lww_counter: 0 }));

    expect(members(playlist.id)).toHaveLength(0);
    expect(
      readTombstone(sq(), 'playlist_song', membershipEntityId(playlist.id, song.id)),
    ).toBeNull();
  });
});

describe('lyrics ops', () => {
  it('queues the write, and replays its own echo', () => {
    const song = createSong(db(), sq(), { name: 's' });
    const lyrics = change('song', song.id, 'set_lyrics', { lrc: '[00:01.00]远端词' });

    apply(lyrics);
    apply({ ...lyrics, server_seq: 99 });

    // Metadata ops carry no key, so re-landing the same document is how they
    // converge — including when the sender is this device.
    expect(journal().filter((o) => o.kind === 'write_lyrics')).toHaveLength(2);
  });

  it('is stopped by the parent gate, tombstone or missing row alike', async () => {
    const gone = createSong(db(), sq(), { name: '删掉' });
    await deleteSong(db(), sq(), gone.id);
    sq().prepare('DELETE FROM sync_file_ops').run();

    const result = apply(
      change('song', gone.id, 'set_lyrics', { lrc: '[00:01.00]x' }),
      change('song', randomUUID(), 'clear_lyrics', {}),
    );

    expect(result).toMatchObject({ applied: 0, skipped: 2 });
    expect(journal()).toHaveLength(0);
  });
});

describe('playlists', () => {
  it('inserts, updates by key, and entombs on delete', () => {
    const id = randomUUID();
    apply(change('playlist', id, 'create', playlistPayload()));
    apply(change('playlist', id, 'update', playlistPayload({ name: '改名', updated_at_ms: 6000 })));

    const row = sq().prepare('SELECT name FROM playlists WHERE id = ?').get(id) as { name: string };
    expect(row.name).toBe('改名');

    apply(change('playlist', id, 'delete', { updated_at_ms: 7000, lww_counter: 0 }));
    expect(sq().prepare('SELECT 1 FROM playlists WHERE id = ?').get(id)).toBeUndefined();
    expect(readTombstone(sq(), 'playlist', id)).not.toBeNull();
  });

  it('adopts a peer order, ignores ids it does not have, and keeps the rest at the tail', () => {
    const playlist = createPlaylist(db(), sq(), 'p');
    const [a, b, c] = ['A', 'B', 'C'].map((n) => createSong(db(), sq(), { name: n }).id);
    addSongsToPlaylist(db(), sq(), playlist.id, [a, b, c]);

    apply(
      change('playlist', playlist.id, 'reorder', {
        // c twice (first position wins), one id this device has never seen,
        // and b left out entirely.
        song_ids: [c, randomUUID(), a, c],
      }),
    );

    expect(members(playlist.id).map((m) => m.song_id)).toEqual([c, a, b]);
    expect(members(playlist.id).map((m) => m.rank)).toEqual([
      RANK_STEP,
      2 * RANK_STEP,
      3 * RANK_STEP,
    ]);
  });

  it('drops a reorder for a playlist that is gone', () => {
    const playlist = createPlaylist(db(), sq(), 'p');
    const song = createSong(db(), sq(), { name: 's' });
    addSongsToPlaylist(db(), sq(), playlist.id, [song.id]);
    apply(change('playlist', playlist.id, 'delete', { updated_at_ms: 9e12, lww_counter: 0 }));

    const result = apply(change('playlist', playlist.id, 'reorder', { song_ids: [song.id] }));
    expect(result).toMatchObject({ applied: 0, skipped: 1 });
  });
});

describe('memberships', () => {
  function membership(playlistId: string, songId: string, overrides: Record<string, unknown> = {}) {
    return {
      playlist_id: playlistId,
      song_id: songId,
      added_at_ms: 4000,
      updated_at_ms: 5000,
      lww_counter: 0,
      ...overrides,
    };
  }

  it('adds at the tail as a placeholder, then takes the paired set_rank', () => {
    const playlist = createPlaylist(db(), sq(), 'p');
    const [a, b] = ['A', 'B'].map((n) => createSong(db(), sq(), { name: n }).id);
    addSongsToPlaylist(db(), sq(), playlist.id, [a]);
    const entityId = membershipEntityId(playlist.id, b);

    apply(change('playlist_song', entityId, 'create', membership(playlist.id, b)));
    // Between the create and its set_rank the song sits at the tail rather
    // than at some arbitrary point in the list.
    expect(members(playlist.id).map((m) => m.song_id)).toEqual([a, b]);

    apply(change('playlist_song', entityId, 'set_rank', { rank: 1 }));
    expect(members(playlist.id).map((m) => m.song_id)).toEqual([b, a]);
  });

  it('only moves the key when the membership already exists here (R5-1)', () => {
    const playlist = createPlaylist(db(), sq(), 'p');
    const song = createSong(db(), sq(), { name: 's' });
    addSongsToPlaylist(db(), sq(), playlist.id, [song.id]);
    const entityId = membershipEntityId(playlist.id, song.id);
    const before = members(playlist.id)[0];

    apply(
      change(
        'playlist_song',
        entityId,
        'create',
        membership(playlist.id, song.id, { added_at_ms: 1, updated_at_ms: 9e12 }),
      ),
    );

    const row = sq()
      .prepare(
        'SELECT added_at, rank, updated_at, device_id FROM playlist_songs WHERE playlist_id=? AND song_id=?',
      )
      .get(playlist.id, song.id) as {
      added_at: number;
      rank: number;
      updated_at: number;
      device_id: string;
    };
    // Local `added_at` and rank survive; the triple converges. Skipping
    // instead would leave two devices holding different keys for one live
    // row, and a delete arriving between them would apply on only one.
    expect(row.rank).toBe(before.rank);
    expect(row.added_at).not.toBe(1);
    expect(row.updated_at).toBe(9e12);
    expect(row.device_id).toBe('peer-1');
  });

  it('revives a removed membership when the create is newer', () => {
    const playlist = createPlaylist(db(), sq(), 'p');
    const song = createSong(db(), sq(), { name: 's' });
    addSongsToPlaylist(db(), sq(), playlist.id, [song.id]);
    removeSongFromPlaylist(db(), sq(), playlist.id, song.id);
    const entityId = membershipEntityId(playlist.id, song.id);

    apply(
      change(
        'playlist_song',
        entityId,
        'create',
        membership(playlist.id, song.id, { updated_at_ms: 9e12 }),
      ),
    );

    // Re-adding a song is ordinary, so membership tombstones lose to a newer
    // create — unlike a song's, which is final.
    expect(members(playlist.id).map((m) => m.song_id)).toEqual([song.id]);
    expect(readTombstone(sq(), 'playlist_song', entityId)).toBeNull();
  });

  it('drops a create that lost to the tombstone, and its paired set_rank with it', () => {
    const playlist = createPlaylist(db(), sq(), 'p');
    const song = createSong(db(), sq(), { name: 's' });
    addSongsToPlaylist(db(), sq(), playlist.id, [song.id]);
    removeSongFromPlaylist(db(), sq(), playlist.id, song.id);
    const entityId = membershipEntityId(playlist.id, song.id);

    const result = apply(
      change(
        'playlist_song',
        entityId,
        'create',
        membership(playlist.id, song.id, { updated_at_ms: 1 }),
      ),
      change('playlist_song', entityId, 'set_rank', { rank: 512 }),
    );

    // The row-exists gate is what stops the set_rank; nothing has to remember
    // that its create was refused.
    expect(result).toMatchObject({ applied: 0, skipped: 2 });
    expect(members(playlist.id)).toHaveLength(0);
  });

  it('needs both parents alive for create and set_rank', async () => {
    const playlist = createPlaylist(db(), sq(), 'p');
    const song = createSong(db(), sq(), { name: 's' });
    addSongsToPlaylist(db(), sq(), playlist.id, [song.id]);
    const entityId = membershipEntityId(playlist.id, song.id);
    await deleteSong(db(), sq(), song.id);

    const result = apply(
      change('playlist_song', entityId, 'create', membership(playlist.id, song.id)),
      change('playlist_song', entityId, 'set_rank', { rank: 1 }),
    );
    expect(result).toMatchObject({ applied: 0, skipped: 2 });
  });

  it('entombs a removal so a stale create cannot undo it', () => {
    const playlist = createPlaylist(db(), sq(), 'p');
    const song = createSong(db(), sq(), { name: 's' });
    addSongsToPlaylist(db(), sq(), playlist.id, [song.id]);
    const entityId = membershipEntityId(playlist.id, song.id);

    apply(change('playlist_song', entityId, 'delete', { updated_at_ms: 9e12, lww_counter: 0 }));

    expect(members(playlist.id)).toHaveLength(0);
    expect(readTombstone(sq(), 'playlist_song', entityId)).not.toBeNull();
  });
});

describe('changes this build cannot read', () => {
  it('archives the whole envelope and keeps going', () => {
    const id = randomUUID();
    const result = apply(
      change('song', id, 'create', { name: 42 }),
      change('unicorn', id, 'create', {}),
      change('song', id, 'create', songPayload({ name: '好的' })),
    );

    expect(result).toMatchObject({ applied: 1, skipped: 2, deadLettered: 2 });
    expect(songRow(id)).toMatchObject({ name: '好的' });

    const letters = sq()
      .prepare("SELECT reason, payload FROM sync_dead_letters WHERE direction='in' ORDER BY id")
      .all() as { reason: string; payload: string }[];
    expect(letters.map((l) => l.reason)).toEqual(['invalid_payload', 'unknown_change']);
    // The archive keeps the wire envelope whole, so the change can be
    // diagnosed — and replayed — later.
    expect(JSON.parse(letters[0].payload)).toMatchObject({
      server_seq: 1,
      client_local_seq: 1,
      server_received_at: 2001,
    });
  });
});

describe('conflicts', () => {
  it('records the losing local copy when the user had unpushed edits', () => {
    const song = createSong(db(), sq(), { name: '我的名字' });

    apply(
      change('song', song.id, 'update', songPayload({ name: '远端名字', updated_at_ms: 9e12 })),
    );

    const [conflict] = listConflicts(sq());
    expect(conflict).toMatchObject({
      entity_type: 'song',
      entity_id: song.id,
      losing_side: 'local',
    });
    expect(JSON.parse(conflict.local_payload as string)).toMatchObject({ name: '我的名字' });
    expect(JSON.parse(conflict.remote_payload as string)).toMatchObject({ name: '远端名字' });
    // The winner's triple is the CAS token a resolve has to present.
    expect(conflict.remote_updated_at_ms).toBe(9e12);
    expect(conflict.remote_device_id).toBe('peer-1');
  });

  it('says nothing when the local copy had already been pushed', () => {
    const song = createSong(db(), sq(), { name: '我的名字' });
    markSynced(lastCid(song.id, 'create'));

    apply(
      change('song', song.id, 'update', songPayload({ name: '远端名字', updated_at_ms: 9e12 })),
    );

    // Nothing was lost: the server has this device's version, and the remote
    // edit is simply the next one.
    expect(listConflicts(sq())).toHaveLength(0);
  });

  it('says nothing when the two versions agree', () => {
    const song = createSong(db(), sq(), { name: '同一个名字' });
    const local = songRow(song.id) as { duration: number; lyrics_offset: number };

    apply(
      change(
        'song',
        song.id,
        'update',
        songPayload({
          name: '同一个名字',
          artist: '',
          duration: local.duration,
          lyrics_offset: local.lyrics_offset,
          updated_at_ms: 9e12,
        }),
      ),
    );

    expect(listConflicts(sq())).toHaveLength(0);
  });
});

describe('the batch belongs to the caller’s transaction', () => {
  it('leaves nothing behind when the cursor write fails', () => {
    const id = randomUUID();
    const doomed = randomUUID();

    expect(() =>
      sq()
        .transaction(() => {
          applyChangesInTx(sq(), [
            change('song', id, 'create', songPayload()),
            change('song', doomed, 'delete', { updated_at_ms: 5000, lww_counter: 0 }),
            change('song', id, 'set_lyrics', { lrc: '[00:01.00]x' }),
          ]);
          // What the engine does next, in the same transaction: advance the
          // cursor. If that fails, replaying the batch must be safe — which it
          // only is if none of it committed.
          throw new Error('cursor write failed');
        })
        .immediate(),
    ).toThrow(/cursor write failed/);

    expect(songRow(id)).toBeUndefined();
    expect(sq().prepare('SELECT count(*) AS n FROM sync_tombstones').get()).toEqual({ n: 0 });
    expect(journal()).toHaveLength(0);
  });
});

describe('applied changes teach the local clock', () => {
  it('makes the next local write outrank what just arrived', () => {
    const id = randomUUID();
    apply(change('song', id, 'create', songPayload({ updated_at_ms: 9e12, lww_counter: 3 })));

    const local = createSong(db(), sq(), { name: '之后写的' });
    const row = songRow(local.id) as { updated_at: number; lww_counter: number };
    // Otherwise the very next local edit would tie with — or lose to — the
    // value the user just watched arrive.
    expect(row.updated_at).toBe(9e12);
    expect(row.lww_counter).toBeGreaterThan(3);
  });
});
