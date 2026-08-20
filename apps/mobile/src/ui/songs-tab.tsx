// The 歌曲 tab (N2f, criteria 14 and 15).
//
// Reads are DERIVED, not mirrored: `listSongs` is a synchronous call on the
// service, so the list is a `useMemo` over (view, search, sort) and there is
// no second copy of the library to keep in step. Sorting is the shared
// `sortSongs` — the same comparator the desktop uses, with the same
// `Intl.Collator('zh-CN')` — rather than `?sort=`, because SQLite has no
// Chinese collation (decision n).
//
// A ROW'S TAP IS PLAY, and the menu is its own button — the shape every
// mobile music app has, and the one a thumb expects. Nothing in this build
// plays (the player is N3, the download link N4), so the tap says so out loud
// rather than doing nothing: a row that swallows taps reads as broken.
//
// Pinned is a channel, not a prefix. The desktop paints four states through
// four things that never collide (`SongRow.tsx`); here the pin sits AFTER the
// duration, in the desktop's own blue, so a long title keeps the whole width
// and an unpinned song shows nothing at all. The amber is the OTHER token and
// stays reserved for the playing row, which lands with the player.

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
import { EllipsisVertical, Pin } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, ToastAndroid, View } from 'react-native';
import { player, usePlayback } from '../player';
import { queueFrom } from '../player/queue';
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
  const [confirming, setConfirming] = useState<SongData | null>(null);

  const songs = useMemo(() => {
    const trimmed = search.trim();
    // `view` is the dependency that makes a write show up: it is a new reader
    // after every one (`library-context.tsx`).
    return sortSongs(view.songs(trimmed === '' ? {} : { search: trimmed }).songs, sort);
  }, [view, search, sort]);

  /** Every write ends the same way: do it, close everything, re-read. */
  const write = (body: () => void) => {
    body();
    closeAll();
    changed();
  };

  // Cancelling has to land in the same place as saving. Dropping back to the
  // menu you came from means a second tap to leave, and the menu is not what
  // anybody wanted to see again.
  const closeAll = () => {
    setActing(null);
    setEditing(null);
    setConfirming(null);
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
        renderItem={({ item }) => (
          <SongRow song={item} songs={songs} onMenu={() => setActing(item)} />
        )}
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

      {acting !== null && editing === null && confirming === null && (
        <Sheet title={acting.name} onClose={closeAll}>
          <SheetAction label="改歌名" onPress={() => setEditing({ song: acting, field: 'name' })} />
          <SheetAction
            label="改歌手"
            onPress={() => setEditing({ song: acting, field: 'artist' })}
          />
          <SheetAction
            label={acting.pinned ? '取消固定' : '固定'}
            onPress={() => write(() => library.pinSong(acting.id, !acting.pinned))}
          />
          <SheetAction label="删除" danger onPress={() => setConfirming(acting)} />
        </Sheet>
      )}

      {confirming !== null && (
        // A delete takes the audio with it, and on a phone there is no undo
        // and no trash — so it asks. Nothing else here does: every other
        // action on this sheet can be done again backwards.
        <Sheet title={`删除《${confirming.name}》？`} onClose={closeAll}>
          <SheetAction
            label="删除，连同它的文件"
            danger
            onPress={() => {
              // The only async write on this screen: `deleteSong` drains the
              // file journal, so the row and its directory go together
              // (`portable/library/songs.ts`).
              void library.deleteSong(confirming.id).then(() => write(() => undefined));
            }}
          />
        </Sheet>
      )}

      {editing !== null && (
        <Prompt
          title={editing.field === 'name' ? '改歌名' : '改歌手'}
          initial={editing.field === 'name' ? editing.song.name : editing.song.artist}
          confirmLabel="保存"
          onClose={closeAll}
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

function SongRow({
  song,
  songs,
  onMenu,
}: { song: SongData; songs: readonly SongData[]; onMenu: () => void }) {
  // Two subscriptions, both primitives (see `usePlayback`): a row re-renders
  // when it becomes the current song and when that song starts or stops, and
  // for nothing else. `currentTime` deliberately does NOT reach here — it
  // changes twice a second and no row shows it.
  const isCurrent = usePlayback((state) => state.song?.id === song.id);
  const playing = usePlayback((state) => state.playing);

  const start = (): void => {
    // Decision j: the tap is never swallowed. A row that does nothing reads as
    // broken, and this one has a real answer — the file is not here yet.
    if (song.has_file === false) {
      ToastAndroid.show('这首还没有文件，下载在 N4 开放', ToastAndroid.SHORT);
      return;
    }
    // The queue is FROZEN here (§2.6): whatever the list holds at the moment
    // of the tap, sort and search and all. Switching tabs afterwards does not
    // change what plays next.
    void (isCurrent ? player.toggle() : player.play(song, queueFrom({ kind: 'all' }, songs)));
  };

  return (
    <View style={styles.row}>
      <Pressable
        style={styles.rowBody}
        onPress={start}
        accessibilityRole="button"
        accessibilityLabel={`播放 ${song.name}`}
      >
        <Text style={[styles.rowName, isCurrent && styles.rowNamePlaying]} numberOfLines={1}>
          {isCurrent && playing ? '▶ ' : ''}
          {song.name}
        </Text>
        <View style={styles.rowMetaLine}>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {song.artist === '' ? '未知歌手' : song.artist} · {duration(song.duration)}
            {song.has_file === false ? ' · 需要下载' : ''}
          </Text>
          {song.pinned && (
            <>
              <Text style={styles.rowMeta}> · </Text>
              <Pin size={12} color={C.pinned} fill={C.pinned} accessibilityLabel="已固定" />
            </>
          )}
        </View>
      </Pressable>
      {/* Its own target, because the row's is play. 44dp is the smallest
          thing a thumb hits reliably. */}
      <Pressable
        style={styles.rowMenu}
        onPress={onMenu}
        accessibilityRole="button"
        accessibilityLabel={`${song.name} 的菜单`}
      >
        <EllipsisVertical size={18} color={C.muted} />
      </Pressable>
    </View>
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
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  rowBody: { flex: 1, paddingVertical: 10, paddingLeft: S.pad },
  rowMenu: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  rowName: { color: C.text, fontSize: 16 },
  // The amber the desktop's dark theme uses for the playing row
  // (`--state-active`, converted in `theme.ts`). Not a colour picked here:
  // N2f put it in the theme with no user precisely so that N3 would not choose
  // a second one.
  rowNamePlaying: { color: C.active },
  rowMetaLine: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  rowMeta: { color: C.faint, fontSize: 12 },
  empty: { color: C.faint, fontSize: 14, padding: S.pad },
});
