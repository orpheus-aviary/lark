// The 歌单 tab: the list, and one detail screen (N2f, criteria 14 and 15).
//
// THE VIRTUAL `all` IS NOT SHOWN HERE, and that is a presentation choice, not
// a disagreement with the library. `listPlaylists()` still returns it first —
// a list that differed between front ends is the M6 divergence the
// LibraryContract exists to pin, and the service is where that is settled.
// What differs is the screen: on a phone the 歌曲 tab already IS every song,
// so an entry called 全部歌曲 next to the real playlists is the same list
// twice. The desktop shows it because its library view and its playlist list
// are different places.
//
// NO DRAG REORDER (subplan §8.3, user's call): long-press is easy to trigger
// by accident and mainstream mobile music apps do not offer it either. The
// service's `reorderPlaylist` is untouched and stays covered by the contract;
// what is missing is the handle, and with it the three native dependencies a
// draggable list would have cost.

import type { SongData } from '@lark/shared';
import { Check } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, ToastAndroid, View } from 'react-native';
import { ensureController } from '../downloads/ensure-runtime';
import { describeBatch, runBatch } from '../library/batch';
import { allChosen, chosenRows, toggleEvery, toggleOne } from '../library/selection';
import { player } from '../player';
import { queueFrom } from '../player/queue';
import { useVisibleQueue } from '../player/visible-queue';
import { sharePlaylistExport } from '../services/playlist-export';
import { useLibrary } from './library-context';
import { PlaylistPicker } from './playlist-picker';
import { SelectionBar } from './selection-bar';
import { Prompt, Sheet, SheetAction } from './sheet';
import { C, S } from './theme';

/**
 * Which playlist is open is the SHELL's state, not this component's.
 *
 * A tab is unmounted while another one is showing, so anything kept here is
 * forgotten the moment somebody looks at 设置 and comes back — and coming back
 * to the list you were already inside is the whole point of a detail screen.
 */
export function PlaylistsTab({
  openId,
  onOpen,
}: {
  openId: string | null;
  onOpen: (id: string | null) => void;
}) {
  return openId === null ? (
    <PlaylistList onOpen={onOpen} />
  ) : (
    <PlaylistDetail id={openId} onBack={() => onOpen(null)} />
  );
}

function PlaylistList({ onOpen }: { onOpen: (id: string) => void }) {
  const { library, view, changed } = useLibrary();
  const [creating, setCreating] = useState(false);
  const playlists = useMemo(
    // The virtual `all` is already gone: `library-context.tsx` drops it once,
    // for every screen, after the add page was found offering it as a download
    // target beside 「仅曲库」 (2026-08-24).
    () => view.playlists(),
    [view],
  );

  return (
    <View style={styles.fill}>
      <Pressable
        style={styles.newButton}
        onPress={() => setCreating(true)}
        accessibilityRole="button"
      >
        <Text style={styles.newLabel}>新建歌单</Text>
      </Pressable>

      <FlatList
        data={playlists}
        keyExtractor={(playlist) => playlist.id}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => onOpen(item.id)} accessibilityRole="button">
            <Text style={styles.rowName}>{item.name}</Text>
            <Text style={styles.rowMeta}>{item.song_count} 首</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>还没有歌单。曲库在「歌曲」里。</Text>}
      />

      {creating && (
        <Prompt
          title="新建歌单"
          initial=""
          confirmLabel="创建"
          onClose={() => setCreating(false)}
          onConfirm={(name) => {
            library.createPlaylist(name);
            setCreating(false);
            changed();
          }}
        />
      )}
    </View>
  );
}

function PlaylistDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { library, view, changed } = useLibrary();
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [acting, setActing] = useState<SongData | null>(null);
  // The same tick model as the songs tab (`library/selection.ts`), keyed by
  // song id. What differs here is one action: 移出歌单, which is not delete.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [addingTo, setAddingTo] = useState<readonly SongData[] | null>(null);
  const [confirmingMany, setConfirmingMany] = useState(false);
  const selecting = chosen.size > 0;

  const detail = useMemo(() => {
    const playlist = view.playlists().find((p) => p.id === id) ?? null;
    return playlist === null ? null : { playlist, songs: view.playlistSongs(id) };
  }, [view, id]);

  // This playlist is the queue a delayed play would use, while it is on screen
  // (N4g, §2.9). `?? []` because the hook cannot be called conditionally and
  // the screen below returns early when the playlist is gone.
  useVisibleQueue(
    useCallback(
      () => queueFrom({ kind: 'playlist', id }, detail?.songs ?? []),
      [id, detail?.songs],
    ),
  );

  // The playlist this screen was opened for is gone. Deleting it from here
  // navigates away on its own (below), so what reaches this branch is the
  // OTHER way it can happen: a stale id — an Activity rebuilt around a
  // playlist that no longer exists, and in N5 a peer that removed it while
  // this screen was open. Going back is the only honest thing left to render.
  if (detail === null) {
    return (
      <View style={styles.fill}>
        <Back onPress={onBack} />
        <Text style={styles.empty}>这个歌单已经不在了。</Text>
      </View>
    );
  }

  const write = (body: () => void) => {
    body();
    setActing(null);
    setAdding(false);
    setRenaming(false);
    changed();
  };

  const rows = useMemo(
    () => (detail?.songs ?? []).map((song) => ({ ...song, key: song.id })),
    [detail?.songs],
  );
  const picked = useMemo(() => chosenRows(rows, chosen), [rows, chosen]);
  const leaveSelection = useCallback(() => setChosen(new Set()), []);

  const batch = async (verb: string, act: (songId: string) => Promise<void> | void) => {
    const ids = picked.map((song) => song.id);
    setBusy(true);
    const outcome = await runBatch(ids, act);
    setBusy(false);
    leaveSelection();
    changed();
    ToastAndroid.show(describeBatch(verb, outcome), ToastAndroid.SHORT);
  };

  const exportPlaylist = async (): Promise<void> => {
    if (detail === null) return;
    try {
      const result = await sharePlaylistExport(library, detail.playlist);
      ToastAndroid.show(
        result.shared
          ? `已导出「${detail.playlist.name}」（${result.songCount} 首）`
          : '这台设备没有可以接收文件的应用',
        ToastAndroid.SHORT,
      );
    } catch (err) {
      ToastAndroid.show(err instanceof Error ? err.message : '导出失败', ToastAndroid.SHORT);
    }
  };

  return (
    <View style={styles.fill}>
      <Back onPress={onBack} />
      <Text style={styles.detailTitle}>{detail.playlist.name}</Text>

      {selecting ? (
        <SelectionBar
          count={chosen.size}
          everyChosen={allChosen(chosen, rows)}
          busy={busy}
          onToggleEvery={() => setChosen(toggleEvery(chosen, rows))}
          onExit={leaveSelection}
          // The same set as the songs tab (decision c), plus the one that only
          // exists inside a playlist. 移出 sits BEFORE 删除 and only 删除 is
          // red: they are one tap apart and one of them is forever.
          actions={[
            {
              label: '固定',
              onPress: () =>
                void batch('固定', (songId) => {
                  library.pinSong(songId, true);
                }),
            },
            {
              label: '取消固定',
              onPress: () =>
                void batch('取消固定', (songId) => {
                  library.pinSong(songId, false);
                }),
            },
            { label: '加入歌单', onPress: () => setAddingTo(picked) },
            {
              label: '移出歌单',
              onPress: () =>
                void batch('移出', (songId) => {
                  // NOT a delete: the song stays in the library, it just
                  // stops being in this list (criterion 57).
                  library.removePlaylistSong(id, songId);
                }),
            },
            { label: '删除', danger: true, onPress: () => setConfirmingMany(true) },
          ]}
        />
      ) : (
        <View style={styles.actions}>
          <Pressable
            style={styles.newButton}
            onPress={() => setAdding(true)}
            accessibilityRole="button"
          >
            <Text style={styles.newLabel}>加歌</Text>
          </Pressable>
          <Pressable
            style={styles.newButton}
            onPress={() => setRenaming(true)}
            accessibilityRole="button"
          >
            <Text style={styles.newLabel}>歌单改名</Text>
          </Pressable>
          {/* Decision f / criterion 39. Not a save dialog: the file goes to the
            app's cache and the system share sheet carries a grant to it
            (`services/playlist-export.ts`). */}
          <Pressable
            style={styles.newButton}
            onPress={() => void exportPlaylist()}
            accessibilityRole="button"
          >
            <Text style={styles.newLabel}>导出</Text>
          </Pressable>
          <Pressable
            style={styles.newButton}
            onPress={() => {
              write(() => library.deletePlaylist(id));
              // Leaving is part of deleting (2026-08-24). The screen below
              // already handles "this playlist is gone" — it has to, because a
              // peer can delete one in N5 — but making somebody tap 返回 out of
              // a playlist THEY just deleted is asking them to confirm it twice.
              onBack();
            }}
            accessibilityRole="button"
          >
            <Text style={[styles.newLabel, styles.danger]}>删除歌单</Text>
          </Pressable>
        </View>
      )}

      <FlatList
        data={detail.songs}
        keyExtractor={(song) => song.id}
        renderItem={({ item }) => (
          // The row is a play target and the menu is its own button — the same
          // shape as the 歌曲 tab, decided by hand-testing in N2f. What differs
          // is the queue: playing from here plays THIS playlist.
          <View style={[styles.rowLine, chosen.has(item.id) && styles.rowChosen]}>
            <Pressable
              style={styles.row}
              onPress={() => {
                if (selecting) {
                  setChosen(toggleOne(chosen, item.id));
                  return;
                }
                const queue = queueFrom({ kind: 'playlist', id }, detail.songs);
                // Same rule as the 歌曲 tab: no file is not a refusal, it is a
                // play with a download in front of it (N4g, decision b).
                if (item.has_file === false) {
                  ensureController().request(item, queue);
                  return;
                }
                void player.play(item, queue);
              }}
              onLongPress={() => setChosen(toggleOne(chosen, item.id))}
              accessibilityRole="button"
              accessibilityLabel={selecting ? `选择 ${item.name}` : `播放 ${item.name}`}
            >
              <View style={styles.rowNameLine}>
                {selecting && (
                  <Check
                    size={16}
                    color={chosen.has(item.id) ? C.text : C.border}
                    accessibilityLabel={chosen.has(item.id) ? '已选' : '未选'}
                  />
                )}
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.name}
                </Text>
              </View>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {item.artist === '' ? '未知歌手' : item.artist}
              </Text>
            </Pressable>
            <Pressable
              style={styles.rowMenu}
              onPress={() => setActing(item)}
              accessibilityRole="button"
              accessibilityLabel={`${item.name} 的操作`}
            >
              <Text style={styles.rowMenuGlyph}>⋮</Text>
            </Pressable>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.empty}>这个歌单还没有歌。</Text>}
      />

      {acting !== null && (
        <Sheet title={acting.name} onClose={() => setActing(null)}>
          <SheetAction
            label="移出歌单"
            danger
            onPress={() => write(() => library.removePlaylistSong(id, acting.id))}
          />
        </Sheet>
      )}

      {renaming && (
        <Prompt
          title="歌单改名"
          initial={detail.playlist.name}
          confirmLabel="保存"
          onClose={() => setRenaming(false)}
          onConfirm={(name) => write(() => library.renamePlaylist(id, name))}
        />
      )}

      {addingTo !== null && (
        <PlaylistPicker
          title={`添加 ${addingTo.length} 首到`}
          onPick={(playlist) => {
            const targets = addingTo;
            setAddingTo(null);
            try {
              library.addPlaylistSongs(
                playlist.id,
                targets.map((song) => song.id),
              );
              ToastAndroid.show(
                `已加入「${playlist.name}」${targets.length} 首`,
                ToastAndroid.SHORT,
              );
            } catch (err) {
              ToastAndroid.show(
                err instanceof Error ? err.message : '加入歌单失败',
                ToastAndroid.SHORT,
              );
            }
            leaveSelection();
            changed();
          }}
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
              void batch('删除', (songId) => library.deleteSong(songId));
            }}
          />
        </Sheet>
      )}

      {adding && (
        <AddSongs
          memberIds={new Set(detail.songs.map((song) => song.id))}
          onClose={() => setAdding(false)}
          // NOT `write()`: that closes every sheet, and this one stays open
          // (decision j). The write still announces itself, which is what
          // takes the song out of the candidate list on the next render.
          onAdd={(songId) => {
            library.addPlaylistSongs(id, [songId]);
            changed();
          }}
        />
      )}
    </View>
  );
}

/** Everything not already in the playlist. Adding what is there is a no-op nobody asked for. */
/**
 * 加歌 — the sheet that adds songs to the playlist you are inside (N4i-2).
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
function AddSongs({
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

  const candidates = useMemo(() => {
    const trimmed = search.trim();
    return view
      .songs(trimmed === '' ? {} : { search: trimmed })
      .songs.filter((song) => !memberIds.has(song.id));
  }, [view, search, memberIds]);

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

function Back({ onPress }: { onPress: () => void }) {
  return (
    <Pressable style={styles.back} onPress={onPress} accessibilityRole="button">
      <Text style={styles.newLabel}>返回歌单列表</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  newButton: {
    alignSelf: 'flex-start',
    marginHorizontal: S.pad,
    marginBottom: S.gap,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: C.surface,
    borderRadius: S.radius,
  },
  newLabel: { color: C.muted, fontSize: 13 },
  danger: { color: C.danger },
  back: { alignSelf: 'flex-start', paddingHorizontal: S.pad, paddingBottom: S.gap },
  detailTitle: { color: C.text, fontSize: 20, paddingHorizontal: S.pad, paddingBottom: S.gap },
  actions: { flexDirection: 'row', flexWrap: 'wrap' },
  rowLine: { flexDirection: 'row', alignItems: 'center' },
  rowMenu: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  rowMenuGlyph: { color: C.muted, fontSize: 20 },
  row: {
    paddingVertical: 10,
    paddingHorizontal: S.pad,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  rowNameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName: { color: C.text, fontSize: 16, flexShrink: 1 },
  // The ticked row — the surface tone, never the amber: that one is the
  // playing row's and the two must stay tellable apart (decision g).
  rowChosen: { backgroundColor: C.surface },
  search: {
    color: C.text,
    backgroundColor: C.bg,
    borderRadius: S.radius,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: S.gap,
  },
  rowMeta: { color: C.faint, fontSize: 12, marginTop: 2 },
  empty: { color: C.faint, fontSize: 14, padding: S.pad },
  picker: { maxHeight: 320 },
});
