// Counting statements without changing behaviour (N0b-2, criteria 17a/17b).
//
// A Proxy between drizzle and the real database. It fixes nothing and hides
// nothing — it only reports how many statements were prepared and how many were
// released, so `prepared - finalized` is the leak, measured on exactly the
// traffic the caller asked about.

import { type SQLiteDatabase, deleteDatabaseSync, openDatabaseSync } from 'expo-sqlite';

export interface Counting {
  db: SQLiteDatabase;
  prepared(): number;
  finalized(): number;
}

export function countingProxy(real: SQLiteDatabase): Counting {
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

/**
 * The songs table, verbatim from migration 0001.
 *
 * Written out rather than migrated because these two probes are about drizzle's
 * driver, not about the chain — the contract's migration group already runs the
 * real thing, and a probe that spent a second migrating would be measuring that
 * instead.
 */
export const SONGS_DDL = `CREATE TABLE songs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, artist TEXT NOT NULL DEFAULT '',
  source_url TEXT, source_provider TEXT, source_key TEXT,
  file_origin TEXT NOT NULL DEFAULT 'downloaded',
  lyrics_offset REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0, last_accessed_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  device_id TEXT, lww_counter INTEGER NOT NULL DEFAULT 0
);`;

/** Open a database that is definitely empty, and hand back its disposer. */
export function openFresh(name: string): { db: SQLiteDatabase; dispose(): void } {
  try {
    deleteDatabaseSync(name);
  } catch {
    // Nothing to delete — the normal case.
  }
  const db = openDatabaseSync(name);
  return {
    db,
    dispose() {
      try {
        db.closeSync();
      } catch {
        // Already closed.
      }
      try {
        deleteDatabaseSync(name);
      } catch {
        // Nothing to delete.
      }
    },
  };
}
