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

import { readSongSort, writeSongSort } from '@lark/core/portable';
import {
  SORT_FIELDS,
  SORT_FIELD_LABELS,
  type SongData,
  type SortState,
  sortLabel,
  sortSongs,
  toggleOrder,
  withField,
} from '@lark/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, ToastAndroid, View } from 'react-native';
import { engineLogger } from '../downloads/log';
import { describeBatch, runBatch } from '../library/batch';
import { allChosen, chosenRows, toggleEvery, toggleOne } from '../library/selection';
import { queueFrom } from '../player/queue';
import { useVisibleQueue } from '../player/visible-queue';
import { BACK, useBack } from './back';
import { EditLink } from './edit-link';
import { useLibrary, useVisibleView } from './library-context';
import { PlaylistPicker } from './playlist-picker';
import { useSongRowHeight } from './row-metrics';
import { SelectionBar } from './selection-bar';
import { Prompt, Sheet, SheetAction } from './sheet';
import { SongActionsSheet } from './song-actions';
import { SongRow } from './song-row';
import { C, S } from './theme';
import { SEARCH_DEBOUNCE_MS, useDebounced } from './use-debounced';

type Editing = { song: SongData; field: 'name' | 'artist' } | null;

export function SongsTab({ visible }: { visible: boolean }) {
  const { boot, library, changed } = useLibrary();
  // Frozen while this tab is hidden, and caught up the moment it is looked at
  // again (`library-context.tsx`). The tabs stay mounted now, so without this
  // every download would re-query and re-sort the whole library for nobody.
  const view = useVisibleView(visible);
  const [search, setSearch] = useState('');
  // Remembered per device (0.5.0): a library listed by 创建时间 came back in
  // its own order on every launch, which reads as the setting not sticking.
  // The search box is deliberately NOT remembered — a filter that survived a
  // relaunch would look like half a library.
  const [sort, setSort] = useState<SortState>(() =>
    readSongSort(boot.deviceSettings, engineLogger),
  );
  const [picking, setPicking] = useState(false);
  const [acting, setActing] = useState<SongData | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirming, setConfirming] = useState<SongData | null>(null);

  const list = useRef<FlatList<SongData>>(null);
  /** Where the list was, so coming back to this tab lands where you left. */
  const offset = useRef(0);

  // A different order, or a different search, is a different list — staying at
  // the same pixel would leave you somewhere unrelated to what you asked for.
  // Called from the two actions rather than watched with an effect: this is a
  // consequence of a tap and a keystroke, not a synchronisation with anything.
  const toTop = useCallback(() => {
    offset.current = 0;
    list.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  /**
   * The only way the order changes — both buttons and the sheet go through it.
   *
   * Nothing waits for the write: the list has already re-sorted, there is no
   * form to report to, and the worst a failed write costs is next launch's
   * default (the same terms `add-tab` remembers the naming mode on).
   */
  const changeSort = (next: SortState): void => {
    setSort(next);
    toTop();
    void writeSongSort(boot.deviceSettings, next).catch((err: unknown) => {
      engineLogger.warn({ err: String(err) }, 'could not remember the song order');
    });
  };
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

  // 🔴 THE LIST FOLLOWS A SETTLED SEARCH, NOT THE KEYSTROKES (P2, 2026-09-02).
  // Every character used to cost a full-table LIKE, a Chinese collation sort
  // and a rebuild of everything below — thrown away by the next character.
  // Same 200ms the desktop has settled on since D6.
  const committed = useDebounced(search, SEARCH_DEBOUNCE_MS);
  const songs = useMemo(() => {
    const trimmed = committed.trim();
    // `view` is the dependency that makes a write show up: it is a new reader
    // after every one (`library-context.tsx`).
    return sortSongs(view.songs(trimmed === '' ? {} : { search: trimmed }).songs, sort);
  }, [view, committed, sort]);

  // The list as it is RIGHT NOW, for the two callers that must not hold a copy
  // of it: a row's tap and a play that starts later. Written during render, the
  // same way `ui/back.ts` holds its action.
  const latest = useRef(songs);
  latest.current = songs;

  // What a play that starts LATER should play out of (N4g, §2.9): this list,
  // as it is AT THAT MOMENT — sort, search and all. It reads the ref rather
  // than closing over an array, so one publication stays true for the tab's
  // whole life instead of being replaced after every write; it is retracted
  // when this tab is unmounted.
  const getQueue = useCallback(() => queueFrom({ kind: 'all' }, latest.current), []);
  useVisibleQueue(getQueue, visible);

  // The three a row hands back. Stable, so `SongRow`'s memo can hold: a
  // closure built per row per render would change every one of them whenever
  // anything on this page did.
  const openMenu = useCallback((song: SongData) => setActing(song), []);
  const toggleRow = useCallback(
    (song: SongData) => setChosen((current) => toggleOne(current, song.id)),
    [],
  );

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

  // 0.1.1 ④. The innermost layer this tab has: a selection is a mode you are
  // IN, and the back key is how a phone leaves a mode.
  // 🔴 A MODAL IS ITS OWN WINDOW, so hiding the pane behind it leaves it on
  // screen, over whatever tab you switched to. Only a PROGRAMMATIC switch can
  // do that — a share arriving turns the app to 添加 (`shell.tsx`) — because a
  // Modal covers the tab bar and takes the back key itself. Rare, and one
  // effect.
  useEffect(() => {
    if (visible) return;
    setPicking(false);
    setActing(null);
    setEditing(null);
    setConfirming(null);
    setLinking(null);
    setAddingTo(null);
    setConfirmingMany(false);
  }, [visible]);

  // `&& visible`: this tab is still mounted while another one is showing, and
  // a selection nobody can see must not answer the back key — it outranks the
  // tab layer, so it would swallow a press meant for「回到歌曲」.
  useBack(
    selecting && visible,
    () => {
      leaveSelection();
      return true;
    },
    BACK.selection,
  );

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

  // Cancelling has to land in the same place as saving. Dropping back to the
  // menu you came from means a second tap to leave, and the menu is not what
  // anybody wanted to see again.
  const closeAll = () => {
    setActing(null);
    setEditing(null);
    setConfirming(null);
  };

  // Known once the first row has laid itself out; `null` before that, and
  // again if the system font size changes (`row-metrics.ts` keeps that half).
  const rowHeight = useSongRowHeight();
  // 🔴 THE THREE RULES ABOUT WHERE THE LIST SITS, and they used to be one.
  // Unmounting a tab answered all three at once — everything started at the
  // top — and one of those answers was wrong (coming back to the tab) while
  // the other two were right by accident. Now they are three lines.
  //
  // Coming back: exactly where you left it. A pane hidden with `display: none`
  // lays out nothing, so the native offset cannot be relied on to survive.
  //
  // TWICE, and both are needed. This effect runs right after the commit that
  // revealed the pane, which may be BEFORE the native layout that gives the
  // list its height back — and a `scrollToOffset` on a list that is still
  // zero-high clamps to the top. `onLayout` below catches that case. Neither
  // can fight the user: `offset` is what the last scroll reported, so a
  // restore that was not needed puts the list where it already is.
  const restore = useCallback(() => {
    if (visible) list.current?.scrollToOffset({ offset: offset.current, animated: false });
  }, [visible]);
  useEffect(() => {
    restore();
  }, [restore]);
  const getItemLayout = useCallback(
    (_: ArrayLike<SongData> | null | undefined, index: number) => ({
      length: rowHeight ?? 0,
      offset: (rowHeight ?? 0) * index,
      index,
    }),
    [rowHeight],
  );
  const renderItem = useCallback(
    ({ item }: { item: SongData }) => (
      <SongRow
        song={item}
        getQueue={getQueue}
        selecting={selecting}
        chosen={chosen.has(item.id)}
        onMenu={openMenu}
        // Long press is the way IN (decision b), and it works on a row that is
        // already ticked too — there is no separate gesture for "add to the
        // selection".
        onLongPress={toggleRow}
        onToggle={toggleRow}
      />
    ),
    [chosen, getQueue, openMenu, selecting, toggleRow],
  );

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
            onChangeText={(next) => {
              setSearch(next);
              toTop();
            }}
            placeholder="搜索歌名或歌手"
            placeholderTextColor={C.faint}
            accessibilityLabel="搜索"
          />
          <Pressable
            style={styles.sortButton}
            onPress={() => changeSort(toggleOrder(sort))}
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
        ref={list}
        data={songs}
        keyExtractor={(song) => song.id}
        onScroll={(event) => {
          offset.current = event.nativeEvent.contentOffset.y;
        }}
        onLayout={restore}
        // Exact from the first frame, so the scroll indicator is drawn once
        // instead of being revised on every batch (`row-metrics.ts`). `null`
        // only until the first row has laid itself out — once per process.
        {...(rowHeight === null ? {} : { getItemLayout })}
        // The tick is not in `data` — it is one Set above this list — so a
        // cell has no prop of its own that changes when it is ticked.
        extraData={chosen}
        renderItem={renderItem}
        ListEmptyComponent={
          <Text style={styles.empty}>{committed === '' ? '曲库是空的。' : '没有匹配的歌。'}</Text>
        }
      />

      {picking && (
        <Sheet title="排序" onClose={() => setPicking(false)}>
          {SORT_FIELDS.map((field) => (
            <SheetAction
              key={field}
              label={SORT_FIELD_LABELS[field]}
              onPress={() => {
                changeSort(withField(sort, field));
                setPicking(false);
              }}
            />
          ))}
        </Sheet>
      )}

      {acting !== null && editing === null && confirming === null && addingTo === null && (
        <SongActionsSheet
          song={acting}
          on={{
            rename: () => setEditing({ song: acting, field: 'name' }),
            artist: () => setEditing({ song: acting, field: 'artist' }),
            playlist: () => setAddingTo([acting]),
            editLink: () => setLinking(acting),
            delete: () => setConfirming(acting),
          }}
          onClose={closeAll}
        />
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
