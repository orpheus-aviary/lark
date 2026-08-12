// Songs that share a `(provider, key)` (v0.2 T3a, D8).
//
// Since 0002 dropped the UNIQUE index, two devices that were both offline can
// each download the same video and both rows survive the merge — there is no
// automatic reconciliation that converges regardless of arrival order, so the
// pair is kept and made VISIBLE instead. Everything here exists to make that
// visibility real: the status badge counts them, `lark songs --duplicates`
// lists them, and every by-key lookup refuses to guess (AMBIGUOUS_SOURCE_KEY)
// until the user deletes the one they do not want.

import type BetterSqlite3 from 'better-sqlite3';

export interface DuplicateSourceKeyGroup {
  provider: string;
  key: string;
  song_ids: string[];
}

/**
 * How many SONGS sit in a duplicate group — not how many groups there are.
 *
 * The number is shown as "N songs share a source with another song", which is
 * the count a user can act on: three rows on one key is one problem but three
 * things to look at.
 */
export function countDuplicateSourceKeySongs(sqlite: BetterSqlite3.Database): number {
  const row = sqlite
    .prepare(
      `SELECT count(*) AS n FROM songs s
       WHERE s.source_provider IS NOT NULL AND s.source_key IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM songs o
           WHERE o.source_provider = s.source_provider
             AND o.source_key = s.source_key
             AND o.id <> s.id
         )`,
    )
    .get() as { n: number };
  return row.n;
}

/** Every duplicate group, oldest song first inside each one. */
export function listDuplicateSourceKeyGroups(
  sqlite: BetterSqlite3.Database,
): DuplicateSourceKeyGroup[] {
  const rows = sqlite
    .prepare(
      `SELECT source_provider AS provider, source_key AS key,
              group_concat(id) AS ids
       FROM (
         SELECT source_provider, source_key, id
         FROM songs
         WHERE source_provider IS NOT NULL AND source_key IS NOT NULL
         ORDER BY created_at, id
       )
       GROUP BY source_provider, source_key
       HAVING count(*) > 1
       ORDER BY source_provider, source_key`,
    )
    .all() as { provider: string; key: string; ids: string }[];
  return rows.map((row) => ({
    provider: row.provider,
    key: row.key,
    song_ids: row.ids.split(','),
  }));
}
