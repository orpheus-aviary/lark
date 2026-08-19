// The pair core's write paths take, built once (N2b; graduated from the
// spike's `sqlite/portable-db.ts`).
//
// Open once, pair once, hand the pair over. Nothing derives one handle from
// the other — drizzle's Expo driver has no `$client`, which is exactly why
// core's `PortableDb` carries both instead of one.
//
// `satisfies` rather than a cast, and a real construction rather than a
// declared value: the interesting failure is a driver whose generics do not
// line up, and only a real instance shows that. The desktop proves its half
// with the same word inside `createDatabase` — one type, two drivers.

import { type PortableDb, schema } from '@lark/core/portable';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { ExpoSqliteShim, type ShimOptions } from './shim';

export function portableDbOf(handle: SQLiteDatabase, options: ShimOptions = {}): PortableDb {
  return {
    drizzle: drizzle(handle, { schema }),
    sqlite: new ExpoSqliteShim(handle, options),
  } satisfies PortableDb;
}
