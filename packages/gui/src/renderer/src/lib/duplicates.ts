// Songs that share a `(provider, key)` with another song (v0.2 T4, D8/§3.4).
//
// Two devices can each add "the same" video while offline, and sync keeps BOTH
// rather than guessing which one to merge — a merge cannot be made order
// independent, coexistence can. The cost is a duplicate the user has to delete,
// and the badge's counter alone does not say WHICH rows they are.
//
// Scoped to the rows on screen, which is all the renderer can honestly do: a
// pair split across two playlists is counted by `/sync/status` and listed by
// `lark songs --duplicates`, and shows up here as soon as both are in view
// (the `all` playlist always shows both).

import type { SongData } from '@lark/shared';

/** Ids of songs whose source key another song in `songs` also claims. */
export function duplicateSourceKeyIds(songs: readonly SongData[]): ReadonlySet<string> {
  const byKey = new Map<string, string[]>();
  for (const song of songs) {
    // A song with no source is not a duplicate of every other song with no
    // source — only a real (provider, key) pair can collide.
    if (song.source_provider === null || song.source_key === null) continue;
    const key = `${song.source_provider}:${song.source_key}`;
    const ids = byKey.get(key);
    if (ids) ids.push(song.id);
    else byKey.set(key, [song.id]);
  }

  const duplicates = new Set<string>();
  for (const ids of byKey.values()) {
    if (ids.length > 1) for (const id of ids) duplicates.add(id);
  }
  return duplicates;
}
