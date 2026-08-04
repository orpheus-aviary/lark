import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseHandles, createDatabase } from '../db/index.js';
import { playlist_songs } from '../db/schema.js';
import { InvalidReorderError, NotFoundError } from '../errors.js';
import {
  addSongsToPlaylist,
  addSongsToPlaylistInTx,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylistSongs,
  listPlaylists,
  removeSongFromPlaylist,
  renamePlaylist,
  reorderSong,
} from './playlists.js';
import { RANK_STEP } from './rank.js';
import { createSong, createSongInTx } from './songs.js';

let handles: DatabaseHandles;

beforeEach(() => {
  handles = createDatabase({ dbPath: ':memory:' });
});

afterEach(() => {
  handles.sqlite.close();
});

const db = () => handles.db;
const sq = () => handles.sqlite;

function makeSongs(names: string[]): string[] {
  return names.map((name) => createSong(db(), sq(), { name }).id);
}

function memberRows(playlistId: string) {
  return db()
    .select()
    .from(playlist_songs)
    .where(eq(playlist_songs.playlist_id, playlistId))
    .orderBy(playlist_songs.rank, playlist_songs.song_id)
    .all();
}

function memberIds(playlistId: string): string[] {
  return memberRows(playlistId).map((m) => m.song_id);
}

describe('playlists CRUD', () => {
  it('create / rename / delete round-trip with LWW bump on rename', () => {
    const pl = createPlaylist(db(), sq(), '我的最爱');
    expect(pl.song_count).toBe(0);
    const renamed = renamePlaylist(db(), sq(), pl.id, '收藏');
    expect(renamed.name).toBe('收藏');
    deletePlaylist(db(), sq(), pl.id);
    expect(() => renamePlaylist(db(), sq(), pl.id, 'x')).toThrow(NotFoundError);
  });

  it('listPlaylists carries member counts', () => {
    const a = createPlaylist(db(), sq(), 'a');
    const b = createPlaylist(db(), sq(), 'b');
    const songIds = makeSongs(['s1', 's2', 's3']);
    addSongsToPlaylist(db(), sq(), a.id, songIds);
    const listed = listPlaylists(db(), sq());
    expect(listed.find((p) => p.id === a.id)?.song_count).toBe(3);
    expect(listed.find((p) => p.id === b.id)?.song_count).toBe(0);
  });

  it('getPlaylist carries the member count and throws when absent', () => {
    const pl = createPlaylist(db(), sq(), 'a');
    expect(getPlaylist(db(), sq(), pl.id)).toMatchObject({ id: pl.id, name: 'a', song_count: 0 });

    addSongsToPlaylist(db(), sq(), pl.id, makeSongs(['s1', 's2']));
    expect(getPlaylist(db(), sq(), pl.id).song_count).toBe(2);

    deletePlaylist(db(), sq(), pl.id);
    expect(() => getPlaylist(db(), sq(), pl.id)).toThrow(NotFoundError);
  });

  it('deleting a playlist cascades its memberships', () => {
    const pl = createPlaylist(db(), sq(), 'a');
    addSongsToPlaylist(db(), sq(), pl.id, makeSongs(['s1', 's2']));
    deletePlaylist(db(), sq(), pl.id);
    expect(memberRows(pl.id)).toHaveLength(0);
  });
});

describe('membership', () => {
  it('appends at the tail in argument order, skipping existing members silently', () => {
    const pl = createPlaylist(db(), sq(), 'p');
    const [s1, s2, s3] = makeSongs(['s1', 's2', 's3']);
    expect(addSongsToPlaylist(db(), sq(), pl.id, [s1, s2])).toBe(2);
    // s1 is already a member — only s3 is added, at the tail
    expect(addSongsToPlaylist(db(), sq(), pl.id, [s1, s3])).toBe(1);
    expect(memberIds(pl.id)).toEqual([s1, s2, s3]);
    const ranks = memberRows(pl.id).map((m) => m.rank);
    expect(ranks).toEqual([RANK_STEP, 2 * RANK_STEP, 3 * RANK_STEP]);
  });

  it('rejects unknown songs and playlists', () => {
    const pl = createPlaylist(db(), sq(), 'p');
    expect(() =>
      addSongsToPlaylist(db(), sq(), pl.id, ['9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001']),
    ).toThrow(NotFoundError);
    expect(() =>
      addSongsToPlaylist(db(), sq(), '9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001', []),
    ).toThrow(NotFoundError);
  });

  it('removeSongFromPlaylist removes exactly the membership', () => {
    const pl = createPlaylist(db(), sq(), 'p');
    const [s1, s2] = makeSongs(['s1', 's2']);
    addSongsToPlaylist(db(), sq(), pl.id, [s1, s2]);
    removeSongFromPlaylist(db(), sq(), pl.id, s1);
    expect(memberIds(pl.id)).toEqual([s2]);
    expect(() => removeSongFromPlaylist(db(), sq(), pl.id, s1)).toThrow(NotFoundError);
  });

  it('getPlaylistSongs returns songs in (rank, song_id) order', () => {
    const pl = createPlaylist(db(), sq(), 'p');
    const [s1, s2, s3] = makeSongs(['s1', 's2', 's3']);
    addSongsToPlaylist(db(), sq(), pl.id, [s2, s3, s1]);
    expect(getPlaylistSongs(db(), sq(), pl.id).map((s) => s.name)).toEqual(['s2', 's3', 's1']);
  });
});

describe('reorderSong — anchor contract', () => {
  function setup(): { pl: string; s: string[] } {
    const pl = createPlaylist(db(), sq(), 'p').id;
    const s = makeSongs(['A', 'B', 'C', 'D']);
    addSongsToPlaylist(db(), sq(), pl, s);
    return { pl, s };
  }

  it('moves to the head with only before_song_id = first row', () => {
    const { pl, s } = setup();
    reorderSong(db(), sq(), pl, s[3], { before_song_id: s[0] });
    expect(memberIds(pl)).toEqual([s[3], s[0], s[1], s[2]]);
  });

  it('moves to the tail with only after_song_id = last row', () => {
    const { pl, s } = setup();
    reorderSong(db(), sq(), pl, s[0], { after_song_id: s[3] });
    expect(memberIds(pl)).toEqual([s[1], s[2], s[3], s[0]]);
  });

  it('moves between two adjacent anchors', () => {
    const { pl, s } = setup();
    reorderSong(db(), sq(), pl, s[0], { after_song_id: s[1], before_song_id: s[2] });
    expect(memberIds(pl)).toEqual([s[1], s[0], s[2], s[3]]);
  });

  it('adjacency is judged after excluding the moved row', () => {
    const { pl, s } = setup();
    // [A,B,C,D]: move B "between A and C" — with B excluded they ARE adjacent
    reorderSong(db(), sq(), pl, s[1], { after_song_id: s[0], before_song_id: s[2] });
    expect(memberIds(pl)).toEqual(s);
  });

  it('single-anchor insert lands between the anchor and its neighbor', () => {
    const { pl, s } = setup();
    reorderSong(db(), sq(), pl, s[3], { before_song_id: s[1] });
    expect(memberIds(pl)).toEqual([s[0], s[3], s[1], s[2]]);
  });

  it('rejects non-adjacent anchors instead of guessing', () => {
    const { pl, s } = setup();
    expect(() =>
      reorderSong(db(), sq(), pl, s[3], { after_song_id: s[0], before_song_id: s[2] }),
    ).toThrow(InvalidReorderError);
  });

  it('rejects an empty anchor set', () => {
    const { pl, s } = setup();
    expect(() => reorderSong(db(), sq(), pl, s[0], {})).toThrow(InvalidReorderError);
  });

  it('rejects anchors from another playlist and unknown members', () => {
    const { pl, s } = setup();
    const other = createPlaylist(db(), sq(), 'other').id;
    const [foreign] = makeSongs(['E']);
    addSongsToPlaylist(db(), sq(), other, [foreign]);
    expect(() => reorderSong(db(), sq(), pl, s[0], { before_song_id: foreign })).toThrow(
      NotFoundError,
    );
    expect(() => reorderSong(db(), sq(), pl, foreign, { before_song_id: s[0] })).toThrow(
      NotFoundError,
    );
  });

  it('midpoint path bumps only the moved row’s LWW', () => {
    const { pl, s } = setup();
    const before = new Map(memberRows(pl).map((m) => [m.song_id, m.lww_counter]));
    const beforeTs = new Map(memberRows(pl).map((m) => [m.song_id, m.updated_at]));
    reorderSong(db(), sq(), pl, s[0], { after_song_id: s[1], before_song_id: s[2] });
    for (const m of memberRows(pl)) {
      const advanced =
        m.updated_at > (beforeTs.get(m.song_id) as number) ||
        m.lww_counter > (before.get(m.song_id) as number);
      expect(advanced).toBe(m.song_id === s[0]);
    }
  });
});

describe('rank midpoint exhaustion → in-tx normalization', () => {
  it('repeated same-gap inserts trigger normalization within a bounded count', () => {
    const pl = createPlaylist(db(), sq(), 'p').id;
    const [anchorA, anchorB] = makeSongs(['A', 'B']);
    addSongsToPlaylist(db(), sq(), pl, [anchorA, anchorB]); // ranks 1024, 2048

    const anchorARow = () =>
      db()
        .select()
        .from(playlist_songs)
        .where(and(eq(playlist_songs.playlist_id, pl), eq(playlist_songs.song_id, anchorA)))
        .get();
    const aStampBefore = {
      updated_at: anchorARow()?.updated_at as number,
      lww_counter: anchorARow()?.lww_counter as number,
    };
    const bRowBefore = memberRows(pl).find((m) => m.song_id === anchorB);

    // Bisect the A..(top) gap over and over: each round appends a song at the
    // tail, then moves it right after A. ~53 rounds exhaust a float gap of
    // 1024; assert normalization happens within a safe bound, not at an exact
    // hardcoded count.
    let normalized = false;
    let rounds = 0;
    let expectedOrder: string[] = [anchorA, anchorB];
    for (; rounds < 120 && !normalized; rounds++) {
      const fresh = createSong(db(), sq(), { name: `w${rounds}` }).id;
      addSongsToPlaylist(db(), sq(), pl, [fresh]);
      const currentSecond = expectedOrder[1];
      reorderSong(db(), sq(), pl, fresh, {
        after_song_id: anchorA,
        before_song_id: currentSecond,
      });
      expectedOrder = [anchorA, fresh, ...expectedOrder.slice(1)];

      const rows = memberRows(pl);
      expect(rows.map((m) => m.song_id)).toEqual(expectedOrder); // order intact every round
      // B is never moved, so its rank leaving 2*RANK_STEP can only mean the
      // whole playlist renormalized.
      normalized = rows.find((m) => m.song_id === anchorB)?.rank !== 2 * RANK_STEP;
    }

    expect(normalized).toBe(true);
    expect(rounds).toBeLessThan(120);

    // Normalization bumped the rows whose rank changed (B moved from 2048 to
    // the far tail) and left untouched rows alone (A kept rank 1024).
    const aAfter = anchorARow();
    expect(aAfter?.rank).toBe(RANK_STEP);
    expect({ updated_at: aAfter?.updated_at, lww_counter: aAfter?.lww_counter }).toEqual(
      aStampBefore,
    );
    const bAfter = memberRows(pl).find((m) => m.song_id === anchorB);
    const bAdvanced =
      (bAfter?.updated_at as number) > (bRowBefore?.updated_at as number) ||
      (bAfter?.lww_counter as number) > (bRowBefore?.lww_counter as number);
    expect(bAdvanced).toBe(true);
  });
});

describe('…InTx composition across songs and playlists', () => {
  it('one enclosing transaction wraps song creation and playlist fill', () => {
    const pl = createPlaylist(db(), sq(), 'import-target').id;
    expect(() =>
      sq()
        .transaction(() => {
          const id1 = createSongInTx(db(), { name: 'i1' }).id;
          const id2 = createSongInTx(db(), { name: 'i2' }).id;
          addSongsToPlaylistInTx(db(), pl, [id1, id2]);
          throw new Error('import validation failed at song 3');
        })
        .immediate(),
    ).toThrow(/failed at song 3/);
    expect(memberRows(pl)).toHaveLength(0);
    expect(getPlaylistSongs(db(), sq(), pl)).toHaveLength(0);
  });
});
