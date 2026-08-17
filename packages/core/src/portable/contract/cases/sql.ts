// The SQL dialect core actually writes (subplan §1.5).
//
// Not a tour of SQLite: every construct here appears in a real query, and the
// case names the file it came from. A host that compiles the schema but gets
// `json_type` or GLOB wrong would pass a "does SQLite work" smoke test and
// then quietly corrupt sync.

import { check, equal, throws } from '../assert.js';
import type { ContractCase } from '../types.js';
import {
  T0,
  addToPlaylist,
  count,
  getRow,
  migrate,
  scalar,
  seedChange,
  seedPlaylist,
  seedSong,
} from './support.js';

const GROUP = 'sql';

export const SQL_CASES: readonly ContractCase[] = [
  {
    group: GROUP,
    name: 'json_extract and json_type read a stored payload',
    run(db) {
      const sqlite = migrate(db.sqlite);
      seedChange(sqlite, 'song-a', JSON.stringify({ updated_at_ms: T0, lww_counter: 3 }));
      const row = getRow(
        sqlite,
        `SELECT json_extract(payload, '$.updated_at_ms') AS ms,
                json_type(payload, '$.updated_at_ms') AS t
           FROM sync_changes WHERE entity_id = ?`,
        'song-a',
      ) as { ms: number; t: string };
      equal(row.ms, T0, 'extracted value');
      equal(row.t, 'integer', 'json_type of an integer literal');
    },
  },
  {
    group: GROUP,
    name: 'json_set stores a bound number as real unless it is CAST',
    run(db) {
      // `sync/rebase.ts` — and the reason its gate accepts ('integer','real').
      // Both halves are asserted, exactly as `rebase.test.ts` does it: the
      // stored type, AND a second pass actually finding the row again.
      const sqlite = migrate(db.sqlite);
      seedChange(sqlite, 'plain', JSON.stringify({ updated_at_ms: 1 }), { clientChangeId: 'c1' });
      seedChange(sqlite, 'cast', JSON.stringify({ updated_at_ms: 1 }), { clientChangeId: 'c2' });

      sqlite
        .prepare(
          `UPDATE sync_changes SET payload = json_set(payload, '$.updated_at_ms', ?)
             WHERE entity_id = 'plain'`,
        )
        .run(T0);
      sqlite
        .prepare(
          `UPDATE sync_changes SET payload = json_set(payload, '$.updated_at_ms', CAST(? AS INTEGER))
             WHERE entity_id = 'cast'`,
        )
        .run(T0);

      equal(
        scalar(
          sqlite,
          `SELECT json_type(payload, '$.updated_at_ms') AS t
             FROM sync_changes WHERE entity_id = 'plain'`,
        ),
        'real',
        'a bound number lands as real',
      );
      equal(
        scalar(
          sqlite,
          `SELECT json_type(payload, '$.updated_at_ms') AS t
             FROM sync_changes WHERE entity_id = 'cast'`,
        ),
        'integer',
        'CAST keeps it an integer',
      );

      // The half that matters downstream: a later pass with an integer-only
      // gate must still find the CAST row, and must not find the other one.
      const found = sqlite
        .prepare(
          `SELECT entity_id FROM sync_changes
             WHERE json_type(payload, '$.updated_at_ms') = 'integer'`,
        )
        .all() as { entity_id: string }[];
      equal(found.length, 1, 'one row survives an integer-only gate');
      equal(found[0].entity_id, 'cast', 'and it is the CAST one');
    },
  },
  {
    group: GROUP,
    name: 'upsert: ON CONFLICT DO UPDATE',
    run(db) {
      const sqlite = migrate(db.sqlite);
      const upsert = sqlite.prepare(
        `INSERT INTO local_metadata (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
      upsert.run('k', 'first');
      upsert.run('k', 'second');
      equal(
        count(sqlite, 'SELECT count(*) AS n FROM local_metadata WHERE key = ?', 'k'),
        1,
        'one row',
      );
      equal(
        scalar(sqlite, 'SELECT value FROM local_metadata WHERE key = ?', 'k'),
        'second',
        'updated',
      );
    },
  },
  {
    group: GROUP,
    name: 'upsert: ON CONFLICT DO NOTHING',
    run(db) {
      const sqlite = migrate(db.sqlite);
      const insert = sqlite.prepare(
        'INSERT INTO local_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
      );
      insert.run('k', 'first');
      const second = insert.run('k', 'second');
      equal(second.changes, 0, 'the second insert changed nothing');
      equal(scalar(sqlite, 'SELECT value FROM local_metadata WHERE key = ?', 'k'), 'first', 'kept');
    },
  },
  {
    group: GROUP,
    name: 'GLOB treats _ literally where LIKE would not',
    run(db) {
      // `sync/unbind.ts` deletes `skybridge_*` keys with GLOB for exactly this
      // reason: under LIKE, `_` is a wildcard and would also match `skybridgeX`.
      const sqlite = migrate(db.sqlite);
      const insert = sqlite.prepare('INSERT INTO local_metadata (key, value) VALUES (?, ?)');
      insert.run('skybridge_token', 'a');
      insert.run('skybridgeXtoken', 'b');
      insert.run('device_uuid', 'c');

      const deleted = sqlite
        .prepare("DELETE FROM local_metadata WHERE key GLOB 'skybridge_*'")
        .run();
      equal(deleted.changes, 1, 'only the underscore key matched');
      // Scoped to the three keys this case wrote: the migration chain seeds
      // local_metadata itself (0003's audio_migration_pending, for one), so
      // counting the whole table would be counting somebody else's rows.
      equal(
        count(
          sqlite,
          "SELECT count(*) AS n FROM local_metadata WHERE key IN ('skybridge_token','skybridgeXtoken','device_uuid')",
        ),
        2,
        'the others survive',
      );
    },
  },
  {
    group: GROUP,
    name: 'LIKE ... ESCAPE searches for a literal % and _',
    run(db) {
      // `library/songs.ts` escapes the user's search string this way.
      const sqlite = migrate(db.sqlite);
      seedSong(sqlite, { id: 's1', name: '100% pure' });
      seedSong(sqlite, { id: 's2', name: '100 percent' });
      seedSong(sqlite, { id: 's3', name: 'a_b' });
      seedSong(sqlite, { id: 's4', name: 'axb' });

      const byPercent = sqlite
        .prepare("SELECT id FROM songs WHERE name LIKE ? ESCAPE '\\'")
        .all('%100\\%%') as { id: string }[];
      equal(byPercent.length, 1, 'literal % matched once');
      equal(byPercent[0].id, 's1', 'and matched the right row');

      const byUnderscore = sqlite
        .prepare("SELECT id FROM songs WHERE name LIKE ? ESCAPE '\\'")
        .all('%a\\_b%') as { id: string }[];
      equal(byUnderscore.length, 1, 'literal _ matched once');
      equal(byUnderscore[0].id, 's3', 'and not the wildcard row');
    },
  },
  {
    group: GROUP,
    name: 'LIKE is case-insensitive for ASCII',
    run(db) {
      // The CLI's fake backend once used `includes()` here and invented a bug
      // that did not exist (M6).
      const sqlite = migrate(db.sqlite);
      seedSong(sqlite, { id: 's1', name: 'Hello' });
      equal(
        count(sqlite, 'SELECT count(*) AS n FROM songs WHERE name LIKE ?', '%hello%'),
        1,
        'lowercase pattern matched',
      );
    },
  },
  {
    group: GROUP,
    name: 'EXISTS correlates a subquery',
    run(db) {
      const sqlite = migrate(db.sqlite);
      const playlist = seedPlaylist(sqlite);
      seedSong(sqlite, { id: 'in-list' });
      seedSong(sqlite, { id: 'not-in-list' });
      addToPlaylist(sqlite, playlist, 'in-list');

      const rows = sqlite
        .prepare(
          `SELECT id FROM songs s
             WHERE EXISTS (SELECT 1 FROM playlist_songs ps WHERE ps.song_id = s.id)`,
        )
        .all() as { id: string }[];
      equal(rows.length, 1, 'one song is in a playlist');
      equal(rows[0].id, 'in-list', 'the right one');
    },
  },
  {
    group: GROUP,
    name: 'group_concat with HAVING finds duplicate keys',
    run(db) {
      // `sync/duplicates.ts` — two songs may legitimately share a source key
      // (D8), and this is how they are surfaced.
      const sqlite = migrate(db.sqlite);
      seedSong(sqlite, { id: 'dup-a', provider: 'bilibili', key: 'BV1:1' });
      seedSong(sqlite, { id: 'dup-b', provider: 'bilibili', key: 'BV1:1' });
      seedSong(sqlite, { id: 'solo', provider: 'bilibili', key: 'BV2:1' });

      const rows = sqlite
        .prepare(
          `SELECT source_key, count(*) AS n, group_concat(id) AS ids
             FROM songs WHERE source_provider IS NOT NULL
             GROUP BY source_provider, source_key HAVING n > 1`,
        )
        .all() as { source_key: string; n: number; ids: string }[];
      equal(rows.length, 1, 'one duplicate group');
      equal(rows[0].n, 2, 'of two');
      check(rows[0].ids.split(',').sort().join(',') === 'dup-a,dup-b', 'both ids listed');
    },
  },
  {
    group: GROUP,
    name: 'sum(CASE WHEN ...) partitions one scan',
    run(db) {
      // `sync/file-ops.ts` and `sync/unbind.ts` both count two ways at once.
      const sqlite = migrate(db.sqlite);
      seedChange(sqlite, 'a', '{}', { op: 'create', clientChangeId: 'c1' });
      seedChange(sqlite, 'b', '{}', { op: 'delete', clientChangeId: 'c2' });
      seedChange(sqlite, 'c', '{}', { op: 'clear_lyrics', clientChangeId: 'c3' });

      const row = getRow(
        sqlite,
        `SELECT count(*) AS total,
                sum(CASE WHEN op IN ('delete','clear_lyrics') THEN 1 ELSE 0 END) AS deletes
           FROM sync_changes`,
      ) as { total: number; deletes: number };
      equal(row.total, 3, 'total');
      equal(row.deletes, 2, 'the deleting ops');
    },
  },
  {
    group: GROUP,
    name: 'CASE inside SET writes different values per row',
    run(db) {
      const sqlite = migrate(db.sqlite);
      seedSong(sqlite, { id: 'p1' });
      seedSong(sqlite, { id: 'p2' });
      sqlite.prepare("UPDATE songs SET pinned = CASE WHEN id = 'p1' THEN 1 ELSE 0 END").run();
      equal(scalar(sqlite, "SELECT pinned FROM songs WHERE id = 'p1'"), 1, 'p1 pinned');
      equal(scalar(sqlite, "SELECT pinned FROM songs WHERE id = 'p2'"), 0, 'p2 not');
    },
  },
  {
    group: GROUP,
    name: 'IS NOT ? is null-safe where <> is not',
    run(db) {
      // `sync/device.ts` re-stamps every row whose device_id differs from
      // ours — including the rows where it is NULL, which `<> ?` would skip.
      const sqlite = migrate(db.sqlite);
      seedSong(sqlite, { id: 'null-device' });
      seedSong(sqlite, { id: 'other-device' });
      sqlite.prepare("UPDATE songs SET device_id = 'them' WHERE id = 'other-device'").run();

      equal(
        count(sqlite, 'SELECT count(*) AS n FROM songs WHERE device_id <> ?', 'us'),
        1,
        '<> skips the NULL row',
      );
      equal(
        count(sqlite, 'SELECT count(*) AS n FROM songs WHERE device_id IS NOT ?', 'us'),
        2,
        'IS NOT includes it',
      );
    },
  },
  {
    group: GROUP,
    name: 'string concatenation with ||',
    run(db) {
      const sqlite = migrate(db.sqlite);
      seedSong(sqlite, { id: 's1', name: 'name', artist: 'artist' });
      equal(
        scalar(sqlite, "SELECT name || ' - ' || artist AS s FROM songs"),
        'name - artist',
        '||',
      );
    },
  },
  {
    group: GROUP,
    name: 'LIMIT and OFFSET take bound parameters',
    run(db) {
      const sqlite = migrate(db.sqlite);
      for (const id of ['s1', 's2', 's3']) seedSong(sqlite, { id });
      const rows = sqlite
        .prepare('SELECT id FROM songs ORDER BY id LIMIT ? OFFSET ?')
        .all(2, 1) as {
        id: string;
      }[];
      equal(rows.length, 2, 'two rows');
      equal(rows[0].id, 's2', 'offset applied');
    },
  },
  {
    group: GROUP,
    name: 'DISTINCT collapses repeats',
    run(db) {
      const sqlite = migrate(db.sqlite);
      seedSong(sqlite, { id: 's1', artist: 'same' });
      seedSong(sqlite, { id: 's2', artist: 'same' });
      seedSong(sqlite, { id: 's3', artist: 'other' });
      const rows = sqlite.prepare('SELECT DISTINCT artist FROM songs').all();
      equal(rows.length, 2, 'two distinct artists');
    },
  },
  {
    group: GROUP,
    name: 'AUTOINCREMENT never reuses a rowid',
    run(db) {
      // The outbox's local_seq is an ordering, not a slot: reusing a number
      // after a delete would make an older change look newer.
      const sqlite = migrate(db.sqlite);
      seedChange(sqlite, 'a', '{}', { clientChangeId: 'c1' });
      seedChange(sqlite, 'b', '{}', { clientChangeId: 'c2' });
      sqlite.prepare('DELETE FROM sync_changes').run();
      seedChange(sqlite, 'c', '{}', { clientChangeId: 'c3' });
      equal(scalar(sqlite, 'SELECT local_seq FROM sync_changes'), 3, 'the counter kept going');
    },
  },
  {
    group: GROUP,
    name: 'foreign keys enforce and cascade once switched on',
    run(db) {
      // The DEFAULT is deliberately not asserted, and finding that out is why
      // this case exists: better-sqlite3 turns foreign keys on when it opens a
      // connection, while SQLite's own default (and expo-sqlite's) is off. A
      // contract that pinned the default would have been pinning one host's
      // convenience. What core actually relies on is the explicit
      // `foreign_keys = ON` in `db/index.ts` — per CONNECTION, so any host that
      // opens a second one has to do it again.
      const sqlite = migrate(db.sqlite);

      sqlite.pragma('foreign_keys = ON');
      equal(sqlite.pragma('foreign_keys', { simple: true }), 1, 'on after the pragma');

      const playlist = seedPlaylist(sqlite);
      seedSong(sqlite, { id: 'song-x' });
      addToPlaylist(sqlite, playlist, 'song-x');

      throws(
        () => addToPlaylist(sqlite, playlist, 'ghost'),
        'a membership row pointing at no song',
      );

      sqlite.prepare('DELETE FROM playlists WHERE id = ?').run(playlist);
      equal(count(sqlite, 'SELECT count(*) AS n FROM playlist_songs'), 0, 'membership cascaded');
      equal(count(sqlite, 'SELECT count(*) AS n FROM songs'), 1, 'the song itself stayed');
    },
  },
  {
    group: GROUP,
    name: 'a partial UNIQUE index constrains only the rows it covers',
    run(db) {
      // v1 shipped `idx_songs_source_key` as a partial UNIQUE index and v2
      // dropped the uniqueness (D8) — so the product schema no longer has one
      // to test. A scratch table keeps the behaviour covered, because the
      // partial-index shape is still all over the schema.
      const sqlite = migrate(db.sqlite);
      sqlite.exec(
        `CREATE TABLE scratch (id TEXT PRIMARY KEY, k TEXT);
         CREATE UNIQUE INDEX idx_scratch_k ON scratch(k) WHERE k IS NOT NULL;`,
      );
      const insert = sqlite.prepare('INSERT INTO scratch (id, k) VALUES (?, ?)');
      insert.run('a', 'same');
      throws(() => insert.run('b', 'same'), 'a duplicate covered value');
      insert.run('c', null);
      insert.run('d', null);
      equal(
        count(sqlite, 'SELECT count(*) AS n FROM scratch WHERE k IS NULL'),
        2,
        'NULLs are free',
      );
    },
  },
];
