// 加歌 — the sheet that adds songs to the playlist you are inside (N4i-2).
//
// Its own file since 0.1.1, when the playlist detail it used to live in grew
// the whole ⋮ menu and went past the repo's 500-line advisory. Nothing about
// it changed in the move.

import { useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput } from 'react-native';
import { useLibrary } from './library-context';
import { Sheet, SheetAction } from './sheet';
import { C, S } from './theme';
import { SEARCH_DEBOUNCE_MS, useDebounced } from './use-debounced';

/**
 * Everything not already in the playlist — adding what is there is a no-op
 * nobody asked for.
 *
 * THREE THINGS CHANGED AT ONCE, and they had to (§1.8). It used to draw every
 * candidate with `ScrollView` + `.map()` and close itself after one add:
 *
 *   SEARCH goes through `view.songs({ search })`, which is the library's own
 *   LIKE over name OR artist — the same one the 歌曲 tab uses. Filtering an
 *   already-fetched array here would be a second matcher to keep honest, and
 *   it would disagree the day the library's escaping changes.
 *
 *   IT STAYS OPEN (decision j). Adding one song of five used to mean opening
 *   this five times, and with a search box that also means typing the query
 *   five times. Each add is a real write, so the counter says 已加 rather than
 *   待加 — there is nothing to undo here, and nothing pretends otherwise.
 *
 *   `FlatList`, because a few hundred songs rendered at once is a sheet that
 *   stutters when it opens (N4f's lesson, in reverse).
 *
 * The candidate list is derived, never mirrored: `memberIds` comes from the
 * screen above and changes as things are added, so a song leaves the list by
 * being a member rather than by being crossed off a copy.
 */
export function AddSongs({
  memberIds,
  onAdd,
  onClose,
}: {
  memberIds: ReadonlySet<string>;
  onAdd: (songId: string) => void;
  onClose: () => void;
}) {
  const { view } = useLibrary();
  const [search, setSearch] = useState('');
  const [added, setAdded] = useState(0);

  // Settled, not per keystroke — the 歌曲 tab's rule and the desktop's
  // (`ui/use-debounced.ts`). This one queries the same library.
  const committed = useDebounced(search, SEARCH_DEBOUNCE_MS);
  const candidates = useMemo(() => {
    const trimmed = committed.trim();
    return view
      .songs(trimmed === '' ? {} : { search: trimmed })
      .songs.filter((song) => !memberIds.has(song.id));
  }, [view, committed, memberIds]);

  return (
    <Sheet title={added === 0 ? '加歌' : `加歌 · 已加 ${added} 首`} onClose={onClose}>
      <TextInput
        style={styles.search}
        value={search}
        onChangeText={setSearch}
        placeholder="搜索歌名或歌手"
        placeholderTextColor={C.faint}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="搜索要加的歌"
      />
      <FlatList
        style={styles.picker}
        data={candidates}
        keyExtractor={(song) => song.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <SheetAction
            label={item.artist === '' ? item.name : `${item.name} · ${item.artist}`}
            onPress={() => {
              onAdd(item.id);
              setAdded((count) => count + 1);
            }}
          />
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {search === '' ? '曲库里的歌都在这个歌单里了。' : '没有匹配的歌。'}
          </Text>
        }
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  search: {
    color: C.text,
    backgroundColor: C.bg,
    borderRadius: S.radius,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: S.gap,
  },
  empty: { color: C.faint, fontSize: 14, padding: S.pad },
  // FIXED, not `maxHeight` (user, 2026-08-25): the list shrinks as a search
  // narrows it, and a sheet that resizes under your thumb while the keyboard
  // is up moves the row you were about to tap. Empty space below two results
  // is the cheaper of the two.
  picker: { height: 320 },
});
