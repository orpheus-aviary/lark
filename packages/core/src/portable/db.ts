// The library's database, as portable code holds it (N1c, decision d).
//
// Two handles onto ONE connection, travelling together. Both are needed and
// neither can be derived from the other on every host:
//
//   `drizzle` is the query builder every read and most writes go through.
//   `sqlite` is the raw handle, because appending to the outbox is raw SQL and
//   MUST land in the same transaction as the business write it describes (§3.1
//   — a change that commits without its outbox row never syncs, and one that
//   commits without its business write is a lie about this device).
//
// It replaces `sqliteOf(db) = db.$client`, which was the same idea expressed as
// a better-sqlite3 escape hatch: drizzle's Expo driver has no `$client`, so on
// a phone that line is not "slightly wrong", it does not exist. Pairing them at
// the ONE place a connection is opened is what makes "the same connection" a
// construction-time fact instead of a convention every call site re-earns.

import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type * as schema from './schema.js';
import type { SqliteLike } from './sqlite.js';

/**
 * What a write returns, as both drivers agree on it.
 *
 * `changes` and nothing else: better-sqlite3 says `lastInsertRowid` and
 * expo-sqlite says `lastInsertRowId`, so the rowid is not a common surface at
 * all. Core reads it in exactly one place (the file-op journal, which is
 * desktop-side and holds a real handle), and everywhere else reads `changes`.
 */
export type PortableRunResult = { changes: number };

/**
 * The drizzle instance, named structurally rather than by driver.
 *
 * `'sync'` because both hosts are synchronous: better-sqlite3 is, and
 * expo-sqlite's `*Sync` API is what the shim uses (N0b-2). Real instances from
 * BOTH drivers are assignable to this — the desktop proves it with a
 * `satisfies` in `db/index.ts`, the phone with a real construction in the
 * spike's typecheck.
 */
export type PortableDrizzle = BaseSQLiteDatabase<'sync', PortableRunResult, typeof schema>;

export interface PortableDb {
  drizzle: PortableDrizzle;
  sqlite: SqliteLike;
}
