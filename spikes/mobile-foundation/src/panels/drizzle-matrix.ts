// The patched drizzle driver, exercised (N0b-2, criterion 17b).
//
// The patch moves `prepareSync` inside each method and releases in a `finally`.
// That is easy to get wrong in a way that only queries notice, so this walks
// all four methods across the shapes that take different code paths inside
// them: the mapped-fields path (which routes through `values()`), the empty
// result, and the error path. The whole run sits behind the same counting Proxy
// as criterion 17a, so the balance is measured on exactly the traffic asserted.
//
// The error case asserts the MESSAGE, not just that something threw. Expo's
// `finalizeSync()` re-raises the statement's last error, so a patch that lets
// it out of the `finally` turns "UNIQUE constraint failed" into a sentence
// about finalizeSync — a failure that still throws, and still looks fine.

import { schema } from '@lark/core/portable';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { type SQLiteDatabase, deleteDatabaseSync, openDatabaseSync } from 'expo-sqlite';
import { ExpoSqliteShim } from '../sqlite/shim';

export interface MatrixRow {
  name: string;
  ok: boolean;
  detail: string;
}

export interface MatrixRun {
  rows: MatrixRow[];
  prepared: number;
  finalized: number;
  leaked: number;
}

interface Counting {
  db: SQLiteDatabase;
  prepared(): number;
  finalized(): number;
}

function countingProxy(real: SQLiteDatabase): Counting {
  let prepared = 0;
  let finalized = 0;
  const proxy = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'prepareSync') {
        return (source: string) => {
          const statement = target.prepareSync(source);
          prepared += 1;
          return new Proxy(statement, {
            get(st, stProp, stReceiver) {
              if (stProp === 'finalizeSync') {
                return () => {
                  finalized += 1;
                  return st.finalizeSync();
                };
              }
              const value = Reflect.get(st, stProp, stReceiver);
              return typeof value === 'function' ? value.bind(st) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, prepared: () => prepared, finalized: () => finalized };
}

const SONGS_DDL = `CREATE TABLE songs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, artist TEXT NOT NULL DEFAULT '',
  source_url TEXT, source_provider TEXT, source_key TEXT,
  file_origin TEXT NOT NULL DEFAULT 'downloaded',
  lyrics_offset REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0, last_accessed_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  device_id TEXT, lww_counter INTEGER NOT NULL DEFAULT 0
);`;

export function runDrizzleMatrix(): MatrixRun {
  const name = 'drizzle-matrix.db';
  try {
    deleteDatabaseSync(name);
  } catch {
    // Nothing to delete.
  }

  const real = openDatabaseSync(name);
  const rows: MatrixRow[] = [];

  const check = (label: string, fn: () => string): void => {
    try {
      rows.push({ name: label, ok: true, detail: fn() });
    } catch (err) {
      rows.push({
        name: label,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const expect = (condition: boolean, message: string): void => {
    if (!condition) throw new Error(message);
  };

  try {
    new ExpoSqliteShim(real).exec(SONGS_DDL);

    const counting = countingProxy(real);
    const db = drizzle(counting.db, { schema });
    const songs = schema.songs;

    check('run · insert reports changes and rowid', () => {
      const r = db
        .insert(songs)
        .values({ id: 'a', name: 'alpha', artist: 'x', created_at: 1, updated_at: 1 })
        .run();
      expect(r.changes === 1, `changes was ${r.changes}`);
      return `changes ${r.changes}, rowid ${r.lastInsertRowId}`;
    });

    check('run · the same prepared query, executed twice', () => {
      // The patch re-prepares per call; a handle that only worked once would
      // show up here and nowhere else.
      const insert = db
        .insert(songs)
        .values({ id: 'b', name: 'beta', artist: 'x', created_at: 1, updated_at: 1 })
        .prepare();
      insert.run();
      const second = db
        .insert(songs)
        .values({ id: 'c', name: 'gamma', artist: 'x', created_at: 1, updated_at: 1 })
        .prepare();
      second.run();
      const all = db.select().from(songs).all();
      expect(all.length === 3, `expected 3 rows, got ${all.length}`);
      return '3 rows';
    });

    check('all · mapped select (fields path)', () => {
      const found = db.select({ id: songs.id, name: songs.name }).from(songs).all();
      expect(found.length === 3, `expected 3, got ${found.length}`);
      expect(found[0].name === 'alpha', `first name was ${String(found[0].name)}`);
      expect(Object.keys(found[0]).length === 2, 'a mapped row should carry exactly two fields');
      return `${found.length} rows, keys ${Object.keys(found[0]).join('+')}`;
    });

    check('all · empty result', () => {
      const found = db.select().from(songs).where(eq(songs.id, 'nobody')).all();
      expect(Array.isArray(found) && found.length === 0, 'expected an empty array');
      return '[]';
    });

    check('get · mapped select', () => {
      const row = db.select({ id: songs.id }).from(songs).where(eq(songs.id, 'b')).get();
      expect(row?.id === 'b', `got ${JSON.stringify(row)}`);
      return JSON.stringify(row);
    });

    check('get · empty result is undefined', () => {
      const row = db.select().from(songs).where(eq(songs.id, 'nobody')).get();
      expect(row === undefined, `got ${JSON.stringify(row)}`);
      return 'undefined';
    });

    check('values · raw rows', () => {
      const raw = db.select({ id: songs.id, name: songs.name }).from(songs).prepare().values();
      expect(Array.isArray(raw) && raw.length === 3, `expected 3 raw rows, got ${raw.length}`);
      expect(Array.isArray(raw[0]), 'each raw row should be an array');
      return `${raw.length} rows, first [${raw[0].join(', ')}]`;
    });

    check('error path keeps the ORIGINAL error', () => {
      let message = '';
      try {
        db.insert(songs)
          .values({ id: 'a', name: 'duplicate', artist: 'x', created_at: 1, updated_at: 1 })
          .run();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message !== '', 'the duplicate insert did not throw');
      expect(
        message.includes('UNIQUE'),
        `the error should name the constraint, got: ${message.slice(0, 120)}`,
      );
      return message.split('\n')[0].slice(0, 80);
    });

    check('the database still works after the failure', () => {
      const all = db.select().from(songs).all();
      expect(all.length === 3, `expected 3, got ${all.length}`);
      return '3 rows';
    });

    const prepared = counting.prepared();
    const finalized = counting.finalized();
    return { rows, prepared, finalized, leaked: prepared - finalized };
  } finally {
    try {
      real.closeSync();
    } catch {
      // Already closed.
    }
    try {
      deleteDatabaseSync(name);
    } catch {
      // Nothing to delete.
    }
  }
}
