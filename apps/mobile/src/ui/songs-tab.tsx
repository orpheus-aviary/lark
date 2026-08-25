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
// mobile music app has, and the one a thumb expects. As of N4g that is true of
// EVERY row, including the ones with no file: tapping one fetches the audio
// and then plays it (decision b), which is one play intent stretched over a
// download — `downloads/ensure.ts` holds the rules and `MiniBar` shows the
// wait. What used to be here was a toast saying the download would arrive in
// N4.
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
import * as Clipboard from 'expo-clipboard';
import { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  ToastAndroid,
  View,
} from 'react-native';
import { downloadRuntimeOnce } from '../downloads/engine';
import { describeBatch, runBatch } from '../library/batch';
import { copyableLink, openableLink, refusalFor } from '../library/links';
import { allChosen, chosenRows, toggleEvery, toggleOne } from '../library/selection';
import { queueFrom } from '../player/queue';
import { useVisibleQueue } from '../player/visible-queue';
import { EditLink } from './edit-link';
import { useLibrary } from './library-context';
import { PlaylistPicker } from './playlist-picker';
import { SelectionBar } from './selection-bar';
import { Prompt, Sheet, SheetAction } from './sheet';
import { SongRow } from './song-row';
import { C, S } from './theme';

type Editing = { song: SongData; field: 'name' | 'artist' } | null;

export function SongsTab() {
  const { library, view, boot, changed } = useLibrary();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [picking, setPicking] = useState(false);
  const [acting, setActing] = useState<SongData | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirming, setConfirming] = useState<SongData | null>(null);
  const [linking, setLinking] = useState<SongData | null>(null);
  /**
   * Which rows are ticked, by song id (`library/selection.ts`).
   *
   * Selection mode IS this set being non-empty — there is no second boolean to
   * disagree with it. Un-ticking the last row therefore leaves the mode, which
   * is what every phone does and one fewer state to get out of sync.
   */
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /** Which selection is being asked about: one row's menu, or the ticked set. */
  const [addingTo, setAddingTo] = useState<readonly SongData[] | null>(null);
  const [confirmingMany, setConfirmingMany] = useState(false);
  const selecting = chosen.size > 0;

  const songs = useMemo(() => {
    const trimmed = search.trim();
    // `view` is the dependency that makes a write show up: it is a new reader
    // after every one (`library-context.tsx`).
    return sortSongs(view.songs(trimmed === '' ? {} : { search: trimmed }).songs, sort);
  }, [view, search, sort]);

  // What a play that starts LATER should play out of (N4g, §2.9): this list,
  // as it is at that moment — sort, search and all. Republished whenever it
  // changes, and retracted when this tab is unmounted.
  useVisibleQueue(useCallback(() => queueFrom({ kind: 'all' }, songs), [songs]));

  /** Every write ends the same way: do it, close everything, re-read. */
  const write = (body: () => void) => {
    body();
    closeAll();
    changed();
  };

  /** Rows as the tick model sees them: the key is the song id (§1.4). */
  const rows = useMemo(() => songs.map((song) => ({ ...song, key: song.id })), [songs]);
  const picked = useMemo(() => chosenRows(rows, chosen), [rows, chosen]);
  const leaveSelection = useCallback(() => setChosen(new Set()), []);

  /**
   * One batch, from the tap to the sentence afterwards (§2.3).
   *
   * ALWAYS leaves selection mode, success or not: the selection was a way of
   * saying what to act on, and it has been acted on. Staying in it invites a
   * second tap on a set whose rows may no longer exist.
   */
  const batch = async (verb: string, act: (id: string) => Promise<void> | void): Promise<void> => {
    const ids = picked.map((song) => song.id);
    setBusy(true);
    const outcome = await runBatch(ids, act);
    setBusy(false);
    leaveSelection();
    closeAll();
    changed();
    ToastAndroid.show(describeBatch(verb, outcome), ToastAndroid.SHORT);
  };

  /** 添加到歌单 for one row or for the ticked set — one sheet, one write. */
  const addTo = (playlist: { id: string; name: string }): void => {
    const targets = addingTo ?? [];
    setAddingTo(null);
    if (targets.length === 0) return;
    try {
      // ONE call: core takes an array, in one transaction, and membership it
      // already has is not added twice (§2.3).
      library.addPlaylistSongs(
        playlist.id,
        targets.map((song) => song.id),
      );
      ToastAndroid.show(`已加入「${playlist.name}」${targets.length} 首`, ToastAndroid.SHORT);
    } catch (err) {
      ToastAndroid.show(err instanceof Error ? err.message : '加入歌单失败', ToastAndroid.SHORT);
    }
    leaveSelection();
    closeAll();
    changed();
  };

  const copyLink = (song: SongData): void => {
    const url = copyableLink(song);
    if (url === null) {
      ToastAndroid.show('这首歌没有链接', ToastAndroid.SHORT);
    } else {
      void Clipboard.setStringAsync(url);
      ToastAndroid.show('链接已复制', ToastAndroid.SHORT);
    }
    closeAll();
  };

  /** 🔴 The allowlist is in `library/links.ts` — only http(s) reaches the system. */
  const openLink = (song: SongData): void => {
    const url = openableLink(song);
    if (url === null) {
      ToastAndroid.show(refusalFor(song) ?? '打不开这个链接', ToastAndroid.SHORT);
    } else {
      void Linking.openURL(url).catch(() => {
        // Nothing on this phone claims http(s), or the system refused. Either
        // way it is worth a word: a menu item that does nothing reads as broken.
        ToastAndroid.show('没有应用能打开这个链接', ToastAndroid.SHORT);
      });
    }
    closeAll();
  };

  /** 重新下载 (criterion 49): the engine answers, and it is the one who speaks. */
  const redownload = (song: SongData) => {
    try {
      downloadRuntimeOnce(boot).engine.enqueueRedownload(song.id);
      ToastAndroid.show(`正在重新下载《${song.name}》`, ToastAndroid.SHORT);
    } catch (err) {
      // A full queue, or a row that went away while the sheet was open. Both
      // are the engine's sentences, and both are better than a silent tap.
      ToastAndroid.show(err instanceof Error ? err.message : '没能排上队', ToastAndroid.SHORT);
    }
    closeAll();
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
      {selecting ? (
        <SelectionBar
          count={chosen.size}
          everyChosen={allChosen(chosen, rows)}
          busy={busy}
          onToggleEvery={() => setChosen(toggleEvery(chosen, rows))}
          onExit={leaveSelection}
          actions={[
            {
              label: '固定',
              onPress: () =>
                void batch('固定', (id) => {
                  library.pinSong(id, true);
                }),
            },
            {
              label: '取消固定',
              onPress: () =>
                void batch('取消固定', (id) => {
                  library.pinSong(id, false);
                }),
            },
            { label: '加入歌单', onPress: () => setAddingTo(picked) },
            { label: '删除', danger: true, onPress: () => setConfirmingMany(true) },
          ]}
        />
      ) : (
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
      )}

      <Text style={styles.count}>{songs.length} 首</Text>

      <FlatList
        data={songs}
        keyExtractor={(song) => song.id}
        renderItem={({ item }) => (
          <SongRow
            song={item}
            songs={songs}
            selecting={selecting}
            chosen={chosen.has(item.id)}
            onMenu={() => setActing(item)}
            // Long press is the way IN (decision b), and it works on a row
            // that is already ticked too — there is no separate gesture for
            // "add to the selection".
            onLongPress={() => setChosen(toggleOne(chosen, item.id))}
            onToggle={() => setChosen(toggleOne(chosen, item.id))}
          />
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

      {acting !== null && editing === null && confirming === null && addingTo === null && (
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
          {/*
            Decision a. A FORCED refetch, which is a different thing from the
            row's tap: that one fetches only what is missing and then plays it,
            this one replaces a file that is already there (a bad transfer, a
            source that has been re-identified since) and plays nothing. Its
            own dedupe key in the engine, for exactly that reason.
          */}
          <SheetAction label="添加到歌单" onPress={() => setAddingTo([acting])} />
          {/* The link three (the desktop's M5-10 set). Copy takes whatever is
              stored; open only takes http(s) (`library/links.ts`); changing it
              is the one that can give a song a link it never had. */}
          <SheetAction label="复制链接" onPress={() => copyLink(acting)} />
          <SheetAction label="用 app 打开" onPress={() => openLink(acting)} />
          <SheetAction label="更改链接" onPress={() => setLinking(acting)} />
          <SheetAction label="重新下载" onPress={() => redownload(acting)} />
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

      {addingTo !== null && (
        <PlaylistPicker
          title={
            addingTo.length === 1
              ? `添加《${addingTo[0]?.name}》到`
              : `添加 ${addingTo.length} 首到`
          }
          onPick={addTo}
          onClose={() => setAddingTo(null)}
        />
      )}

      {confirmingMany && (
        <Sheet title={`删除选中的 ${chosen.size} 首？`} onClose={() => setConfirmingMany(false)}>
          <SheetAction
            label="删除，连同它们的文件"
            danger
            onPress={() => {
              setConfirmingMany(false);
              // Deleting is the one action that is per-song and awaited: each
              // one drains the file journal (§2.3), so ten songs are ten
              // drains and the bar shows a spinner while they run.
              void batch('删除', (id) => library.deleteSong(id));
            }}
          />
        </Sheet>
      )}

      {linking !== null && <EditLink song={linking} onClose={() => setLinking(null)} />}

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
  empty: { color: C.faint, fontSize: 14, padding: S.pad },
});
