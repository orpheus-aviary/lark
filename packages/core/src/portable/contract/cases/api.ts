// The handle's shape: binding, misses, run results, exec, pragma, numbers.
//
// Every assertion here restates something core already depends on somewhere.
// `.get()` returning `undefined` rather than null on a miss, for instance, is
// what fifty `as Row | undefined` casts in core are written against.

import { check, equal, throws } from '../assert.js';
import type { ContractCase } from '../types.js';
import { T0, count, getRow, migrate, scalar, seedSong } from './support.js';

const GROUP = 'api';

export const API_CASES: readonly ContractCase[] = [
  {
    group: GROUP,
    name: 'binds positional parameters',
    run(db) {
      const sqlite = migrate(db.sqlite);
      seedSong(sqlite, { id: 'song-a', name: 'positional' });
      const row = getRow(sqlite, 'SELECT name FROM songs WHERE id = ?', 'song-a') as {
        name: string;
      };
      equal(row.name, 'positional', 'positional binding');
    },
  },
  {
    group: GROUP,
    name: 'binds one object of named parameters',
    run(db) {
      const sqlite = migrate(db.sqlite);
      sqlite
        .prepare(
          `INSERT INTO songs (id, name, artist, created_at, updated_at)
           VALUES (@id, @name, @artist, @at, @at)`,
        )
        .run({ id: 'song-b', name: 'named', artist: 'x', at: T0 });
      const row = getRow(sqlite, 'SELECT name FROM songs WHERE id = ?', 'song-b') as {
        name: string;
      };
      equal(row.name, 'named', 'named binding');
    },
  },
  {
    group: GROUP,
    // MEASURED (N0b-5a): the expo shim read a lone `Uint8Array` as the
    // named-parameter FORM and rejected it — "bound key '0' does not appear as
    // a named parameter". Nothing in core binds a blob today, so nothing here
    // asked; but the handle's doc lists bytes among the value forms, which
    // makes "one object" and "one bytes value" ambiguous for any host that
    // decides the form by looking at the argument. This case is the
    // disambiguation, stated once, for both hosts.
    name: 'binds a lone bytes value as a positional parameter',
    run(db) {
      const sqlite = migrate(db.sqlite);
      sqlite.exec('CREATE TABLE contract_bytes (id INTEGER PRIMARY KEY, payload BLOB)');
      const bytes = new Uint8Array([0, 1, 250, 3, 255]);
      sqlite.prepare('INSERT INTO contract_bytes (payload) VALUES (?)').run(bytes);

      const row = getRow(sqlite, 'SELECT payload FROM contract_bytes') as { payload: unknown };
      // better-sqlite3 hands back a Buffer, expo-sqlite a Uint8Array. Both are
      // views over the same bytes, and which one is a host detail — the
      // contract is about the round trip.
      check(ArrayBuffer.isView(row.payload), 'a BLOB comes back as a byte view');
      const source = row.payload as ArrayBufferView;
      const view = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      equal(view.byteLength, bytes.byteLength, 'byte length round trip');
      equal(Array.from(view).join(','), Array.from(bytes).join(','), 'bytes round trip');
    },
  },
  {
    group: GROUP,
    name: 'runs a statement with no parameters',
    run(db) {
      const sqlite = migrate(db.sqlite);
      equal(count(sqlite, 'SELECT count(*) AS n FROM songs'), 0, 'empty table count');
    },
  },
  {
    group: GROUP,
    name: 'get() answers undefined on a miss',
    run(db) {
      const sqlite = migrate(db.sqlite);
      const row = getRow(sqlite, 'SELECT * FROM songs WHERE id = ?', 'nobody');
      equal(row, undefined, 'missing row');
    },
  },
  {
    group: GROUP,
    name: 'all() answers an empty array on a miss',
    run(db) {
      const sqlite = migrate(db.sqlite);
      const rows = sqlite.prepare('SELECT * FROM songs WHERE id = ?').all('nobody');
      check(Array.isArray(rows), 'all() returns an array');
      equal(rows.length, 0, 'no rows');
    },
  },
  {
    group: GROUP,
    name: 'run() reports changes and lastInsertRowid',
    run(db) {
      const sqlite = migrate(db.sqlite);

      // sync_changes.local_seq is INTEGER PRIMARY KEY AUTOINCREMENT, so the
      // rowid is meaningful here — songs has a TEXT primary key.
      const insert = sqlite
        .prepare(
          `INSERT INTO sync_changes
             (device_id, entity_type, entity_id, op, payload, created_at)
           VALUES ('d', 'song', ?, 'create', '{}', ?)`,
        )
        .run('song-a', T0);
      equal(insert.changes, 1, 'one row inserted');
      equal(Number(insert.lastInsertRowid), 1, 'first rowid');

      sqlite
        .prepare(
          `INSERT INTO sync_changes
             (device_id, entity_type, entity_id, op, payload, created_at)
           VALUES ('d', 'song', ?, 'create', '{}', ?)`,
        )
        .run('song-b', T0);

      const updated = sqlite.prepare('UPDATE sync_changes SET op = ?').run('update');
      equal(updated.changes, 2, 'both rows updated');

      const missed = sqlite.prepare('DELETE FROM sync_changes WHERE entity_id = ?').run('nobody');
      equal(missed.changes, 0, 'no rows deleted');
    },
  },
  {
    group: GROUP,
    name: 'exec() runs several statements in one string',
    run(db) {
      const sqlite = migrate(db.sqlite);
      sqlite.exec(
        `INSERT INTO songs (id, name, artist, created_at, updated_at)
           VALUES ('m1', 'one', '', ${T0}, ${T0});
         INSERT INTO songs (id, name, artist, created_at, updated_at)
           VALUES ('m2', 'two', '', ${T0}, ${T0});`,
      );
      equal(count(sqlite, 'SELECT count(*) AS n FROM songs'), 2, 'both statements ran');
    },
  },
  {
    group: GROUP,
    name: 'pragma answers rows, and a scalar with { simple: true }',
    run(db) {
      const sqlite = migrate(db.sqlite);

      const info = sqlite.pragma('table_info(songs)') as { name: string }[];
      check(Array.isArray(info), 'table_info returns rows');
      check(
        info.some((c) => c.name === 'source_key'),
        'table_info names the columns',
      );

      const version = sqlite.pragma('user_version', { simple: true });
      equal(typeof version, 'number', 'simple pragma is a scalar');
    },
  },
  {
    group: GROUP,
    name: 'integers come back as numbers, not bigint',
    run(db) {
      const sqlite = migrate(db.sqlite);
      // A real millisecond timestamp: comfortably past 2^32, comfortably
      // inside Number.MAX_SAFE_INTEGER. core has no safeIntegers mode, so
      // every consumer treats these as plain numbers.
      seedSong(sqlite, { id: 'song-t', createdAt: T0 });
      const value = scalar(sqlite, 'SELECT created_at FROM songs WHERE id = ?', 'song-t');
      equal(typeof value, 'number', 'timestamp is a number');
      equal(value, T0, 'timestamp round-trips');
    },
  },
  {
    group: GROUP,
    name: 'null binds and reads back as null',
    run(db) {
      const sqlite = migrate(db.sqlite);
      seedSong(sqlite, { id: 'song-n', provider: null, key: null });
      const row = getRow(sqlite, 'SELECT source_key FROM songs WHERE id = ?', 'song-n') as {
        source_key: unknown;
      };
      equal(row.source_key, null, 'null column');
    },
  },
  {
    group: GROUP,
    name: 'a constraint violation throws',
    run(db) {
      const sqlite = migrate(db.sqlite);
      seedSong(sqlite, { id: 'dup' });
      throws(() => seedSong(sqlite, { id: 'dup' }), 'duplicate primary key');
      equal(count(sqlite, 'SELECT count(*) AS n FROM songs'), 1, 'the row did not double');
    },
  },
  {
    group: GROUP,
    name: 'a CHECK violation throws',
    run(db) {
      const sqlite = migrate(db.sqlite);
      throws(
        () => seedSong(sqlite, { id: 'half', provider: 'bilibili', key: null }),
        'half-set source pair',
      );
    },
  },
];
