// The phone's half of criterion 9: a REAL `PortableDb`, built from the Expo
// driver and the shim, checked against the type core's write paths take.
//
// The desktop proves its side with a `satisfies` inside `createDatabase`. That
// alone would only prove better-sqlite3 fits a type written while looking at
// better-sqlite3 — the claim that matters is that BOTH drivers fit ONE type,
// and this is the other half of it. `satisfies` rather than a cast, and a real
// construction rather than a declared value, because the interesting failure
// is a driver whose generics do not line up, which only a real instance shows.
//
// This is also the shape N2's bootstrap will use: open once, pair once, hand
// the pair to core. Nothing derives one handle from the other — drizzle's Expo
// driver has no `$client`, which is exactly why `sqliteOf` had to go.

import { type PortableDb, schema } from '@lark/core/portable';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { ExpoSqliteShim } from './shim';

export function portableDbOf(handle: SQLiteDatabase): PortableDb {
  return {
    drizzle: drizzle(handle, { schema }),
    sqlite: new ExpoSqliteShim(handle),
  } satisfies PortableDb;
}
