// Does drizzle's Expo driver finalize what it prepares? (N0b-2, criterion 17a)
//
// drizzle-orm #4519 says no: `ExpoSQLitePreparedQuery` calls `prepareSync()`
// and never calls `finalizeSync()`. The issue is open, has no maintainer
// response and no linked PR — so D4's first exit ("upgrade to a fixed version")
// does not exist, and the choice is between patching and dropping the query
// layer on mobile. This is the measurement that decides it with evidence rather
// than a bug report.
//
// Run it before and after the patch: the same button answers both halves.

import { schema } from '@lark/core/portable';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { ExpoSqliteShim } from '../sqlite/shim';
import { SONGS_DDL, countingProxy, openFresh } from './counting-proxy';

export interface LifecycleProbe {
  queries: number;
  prepared: number;
  finalized: number;
  leaked: number;
  ms: number;
}

/**
 * Run `queries` drizzle selects against a fresh database and report the
 * balance. Selects rather than writes on purpose: a leak on the read path is
 * what a list screen does thousands of times.
 */
export function probeDrizzleLifecycle(queries: number): LifecycleProbe {
  const { db: real, dispose } = openFresh('drizzle-lifecycle.db');
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
    dispose();
  }
}
