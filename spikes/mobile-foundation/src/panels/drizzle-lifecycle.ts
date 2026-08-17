// Does drizzle's Expo driver finalize what it prepares? (N0b-2, criterion 17a)
//
// drizzle-orm #4519 says no: `ExpoSQLitePreparedQuery` calls `prepareSync()`
// and never calls `finalizeSync()`. The issue is open, has no maintainer
// response and no linked PR — so D4's first exit ("upgrade to a fixed version")
// does not exist, and the choice is between patching and dropping the query
// layer on mobile. This is the measurement that decides it with evidence rather
// than a bug report.
//
// A counting Proxy sits between drizzle and the real database. It cannot fix
// anything; it only reports how many statements were prepared and how many were
// released. `prepared - finalized` after a known number of queries IS the leak.

import { schema } from '@lark/core/portable';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { type SQLiteDatabase, deleteDatabaseSync, openDatabaseSync } from 'expo-sqlite';
import { ExpoSqliteShim } from '../sqlite/shim';

export interface LifecycleProbe {
  queries: number;
  prepared: number;
  finalized: number;
  leaked: number;
  ms: number;
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

/**
 * Run `queries` drizzle selects against a fresh database and report the
 * balance. Selects rather than writes on purpose: a leak on the read path is
 * what a list screen does thousands of times.
 */
export function probeDrizzleLifecycle(queries: number): LifecycleProbe {
  const name = 'drizzle-lifecycle.db';
  try {
    deleteDatabaseSync(name);
  } catch {
    // Nothing to delete.
  }

  const real = openDatabaseSync(name);
  try {
    // Setup goes through the shim, whose own prepare/finalize is balanced and,
    // more to the point, is not what is being measured — the Proxy is installed
    // afterwards.
    const shim = new ExpoSqliteShim(real);
    shim.exec(SONGS_DDL);
    shim
      .prepare('INSERT INTO songs (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('probe', 'a song', 0, 0);

    const counting = countingProxy(real);
    const db = drizzle(counting.db, { schema });

    const started = Date.now();
    for (let i = 0; i < queries; i++) {
      db.select().from(schema.songs).all();
    }
    const ms = Date.now() - started;

    const prepared = counting.prepared();
    const finalized = counting.finalized();
    return { queries, prepared, finalized, leaked: prepared - finalized, ms };
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
