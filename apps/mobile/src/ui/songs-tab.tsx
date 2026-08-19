// The 歌曲 tab (N2f, criteria 14 and 15).
//
// Reads are DERIVED, not mirrored: `listSongs` is a synchronous call on the
// service, so the list is a `useMemo` over (view, search, sort) and there is
// no second copy of the library to keep in step. Sorting is the shared
// `sortSongs` — the same comparator the desktop uses, with the same
// `Intl.Collator('zh-CN')` — rather than `?sort=`, because SQLite has no
// Chinese collation (decision n).
//
// A row does not play. Nothing in this build plays: the player is N3 and the
// download link is N4, so a tap opens the actions instead. Saying that here
// because "the list does not respond to a tap" is otherwise a bug report
// waiting to happen.

import {
  DEFAULT_SORT,
  SORT_FIELDS,
  SORT_FIELD_LABELS,
  type SongData,
  type SortState,
  sortLabel,
  sortSongs,
  toggleOrder,
  withField,
} from '@lark/shared';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLibrary } from './library-context';
import { Prompt, Sheet, SheetAction } from './sheet';
import { C, S } from './theme';

type Editing = { song: SongData; field: 'name' | 'artist' } | null;

export function SongsTab() {
  const { library, view, changed } = useLibrary();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [picking, setPicking] = useState(false);
  const [acting, setActing] = useState<SongData | null>(null);
  const [editing, setEditing] = useState<Editing>(null);

  const songs = useMemo(() => {
    const trimmed = search.trim();
    // `view` is the dependency that makes a write show up: it is a new reader
    // after every one (`library-context.tsx`).
    return sortSongs(view.songs(trimmed === '' ? {} : { search: trimmed }).songs, sort);
  }, [view, search, sort]);

  const write = (body: () => void) => {
    body();
    setActing(null);
    setEditing(null);
    changed();
  };

  return (
    <View style={styles.fill}>
      <View style={styles.controls}>
        <TextInput
          style={styles.search}
          value={search}
          onChangeText={setSearch}
          placeholder="搜索歌名或歌手"
          placeholderTextColor={C.faint}
          accessibilityLabel="搜索"
        />
        <Pressable
          style={styles.sortButton}
          onPress={() => setSort(toggleOrder(sort))}
          accessibilityRole="button"
        >
          <Text style={styles.sortLabel}>{sortLabel(sort)}</Text>
        </Pressable>
        <Pressable
          style={styles.sortButton}
          onPress={() => setPicking(true)}
          accessibilityRole="button"
        >
          <Text style={styles.sortLabel}>排序</Text>
        </Pressable>
      </View>

      <Text style={styles.count}>{songs.length} 首</Text>

      <FlatList
        data={songs}
        keyExtractor={(song) => song.id}
        renderItem={({ item }) => <SongRow song={item} onPress={() => setActing(item)} />}
        ListEmptyComponent={
          <Text style={styles.empty}>{search === '' ? '曲库是空的。' : '没有匹配的歌。'}</Text>
        }
      />

      {picking && (
        <Sheet title="排序" onClose={() => setPicking(false)}>
          {SORT_FIELDS.map((field) => (
            <SheetAction
              key={field}
              label={SORT_FIELD_LABELS[field]}
              onPress={() => {
                setSort(withField(sort, field));
                setPicking(false);
              }}
            />
          ))}
        </Sheet>
      )}

      {acting !== null && editing === null && (
        <Sheet title={acting.name} onClose={() => setActing(null)}>
          <SheetAction label="改歌名" onPress={() => setEditing({ song: acting, field: 'name' })} />
          <SheetAction
            label="改歌手"
            onPress={() => setEditing({ song: acting, field: 'artist' })}
          />
          <SheetAction
            label={acting.pinned ? '取消固定' : '固定'}
            onPress={() => write(() => library.pinSong(acting.id, !acting.pinned))}
          />
          <SheetAction
            label="删除"
            danger
            onPress={() => {
              // The only async write on this screen: `deleteSong` drains the
              // file journal, so the row and its directory go together
              // (`portable/library/songs.ts`).
              void library.deleteSong(acting.id).then(() => write(() => undefined));
            }}
          />
        </Sheet>
      )}

      {editing !== null && (
        <Prompt
          title={editing.field === 'name' ? '改歌名' : '改歌手'}
          initial={editing.field === 'name' ? editing.song.name : editing.song.artist}
          confirmLabel="保存"
          onClose={() => setEditing(null)}
          onConfirm={(value) =>
            write(() =>
              library.updateSong(
                editing.song.id,
                editing.field === 'name' ? { name: value } : { artist: value },
              ),
            )
          }
        />
      )}
    </View>
  );
}

function SongRow({ song, onPress }: { song: SongData; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress} accessibilityRole="button">
      <View style={styles.fill}>
        <Text style={styles.rowName} numberOfLines={1}>
          {song.pinned ? '📌 ' : ''}
          {song.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {song.artist === '' ? '未知歌手' : song.artist} · {duration(song.duration)}
          {song.has_file === false ? ' · 需要下载' : ''}
        </Text>
      </View>
    </Pressable>
  );
}

/** `m:ss`, and `--:--` for a song nobody has measured yet. */
function duration(seconds: number): string {
  if (seconds <= 0) return '--:--';
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  controls: { flexDirection: 'row', gap: S.gap, paddingHorizontal: S.pad, paddingBottom: S.gap },
  search: {
    flex: 1,
    color: C.text,
    backgroundColor: C.surface,
    borderRadius: S.radius,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  sortButton: {
    justifyContent: 'center',
    paddingHorizontal: 12,
    backgroundColor: C.surface,
    borderRadius: S.radius,
  },
  sortLabel: { color: C.muted, fontSize: 13 },
  count: { color: C.faint, fontSize: 12, paddingHorizontal: S.pad, paddingBottom: 4 },
  row: {
    paddingVertical: 10,
    paddingHorizontal: S.pad,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  rowName: { color: C.text, fontSize: 16 },
  rowMeta: { color: C.faint, fontSize: 12, marginTop: 2 },
  empty: { color: C.faint, fontSize: 14, padding: S.pad },
});
