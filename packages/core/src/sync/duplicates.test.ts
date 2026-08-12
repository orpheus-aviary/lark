import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseHandles, createDatabase } from '../db/index.js';
import { countDuplicateSourceKeySongs, listDuplicateSourceKeyGroups } from './duplicates.js';

let handles: DatabaseHandles;

beforeEach(() => {
  handles = createDatabase({ dbPath: ':memory:' });
});

afterEach(() => {
  handles.sqlite.close();
});

const sq = () => handles.sqlite;

/** Insert straight to the table: local paths still refuse duplicates, only sync makes them. */
function insertSong(options: {
  provider: string | null;
  key: string | null;
  createdAt: number;
}): string {
  const id = randomUUID();
  sq()
    .prepare(
      `INSERT INTO songs (id, name, artist, source_provider, source_key, file_origin,
         created_at, updated_at, lww_counter)
       VALUES (?, 'n', 'a', ?, ?, 'downloaded', ?, ?, 0)`,
    )
    .run(id, options.provider, options.key, options.createdAt, options.createdAt);
  return id;
}

describe('duplicate source keys (D8)', () => {
  it('counts nothing in a clean library', () => {
    insertSong({ provider: 'bilibili', key: 'BV1:1', createdAt: 1 });
    insertSong({ provider: 'bilibili', key: 'BV2:1', createdAt: 2 });
    insertSong({ provider: null, key: null, createdAt: 3 });
    expect(countDuplicateSourceKeySongs(sq())).toBe(0);
    expect(listDuplicateSourceKeyGroups(sq())).toEqual([]);
  });

  it('counts SONGS, not groups', () => {
    insertSong({ provider: 'bilibili', key: 'BV1:1', createdAt: 1 });
    insertSong({ provider: 'bilibili', key: 'BV1:1', createdAt: 2 });
    insertSong({ provider: 'bilibili', key: 'BV1:1', createdAt: 3 });
    expect(countDuplicateSourceKeySongs(sq())).toBe(3);
    expect(listDuplicateSourceKeyGroups(sq())).toHaveLength(1);
  });

  it('does not treat two NULL keys as the same source', () => {
    insertSong({ provider: null, key: null, createdAt: 1 });
    insertSong({ provider: null, key: null, createdAt: 2 });
    // Go-migrated songs all have no source at all — they are not duplicates.
    expect(countDuplicateSourceKeySongs(sq())).toBe(0);
  });

  it('keys on the pair, not on the key alone', () => {
    insertSong({ provider: 'bilibili', key: 'shared', createdAt: 1 });
    insertSong({ provider: 'other', key: 'shared', createdAt: 2 });
    expect(countDuplicateSourceKeySongs(sq())).toBe(0);
  });

  it('lists each group oldest-first', () => {
    const first = insertSong({ provider: 'bilibili', key: 'BV1:1', createdAt: 100 });
    const second = insertSong({ provider: 'bilibili', key: 'BV1:1', createdAt: 200 });
    expect(listDuplicateSourceKeyGroups(sq())).toEqual([
      { provider: 'bilibili', key: 'BV1:1', song_ids: [first, second] },
    ]);
  });
});
