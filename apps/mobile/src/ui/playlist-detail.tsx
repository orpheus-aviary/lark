// One playlist, opened (0.1.1 ⑩ ④; split out of `playlists-tab.tsx`).
//
// ITS OWN FILE because of what 0.1.1 added to it: a song's ⋮ menu here is now
// the SAME menu as the 歌曲 tab's (`ui/song-actions.tsx`), which means this
// screen also owns everything that menu delegates — a rename prompt, an artist
// prompt, a link editor and a single-song confirmation. `playlists-tab.tsx`
// was 592 lines before any of that, over the repo's 500-line advisory.
//
// WHAT DIFFERS FROM THE 歌曲 TAB, and all of it is the playlist:
//   - playing from here plays THIS playlist as the queue;
//   - the menu carries one more entry, 移出歌单, which is not a delete;
//   - the back key closes the screen (`ui/back.ts`, `BACK.screen`) — until
//     0.1.1 it left the app, because this is the one screen in the app that is
//     not a `Modal` and so had nobody answering for it.

import { MIB, readCacheLimitMb } from '@lark/core/portable';
import type { SongData } from '@lark/shared';
import { Check } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import { readDeviceUsage } from '../cache/usage';
import {
  bytesPerSecondOf,
  describeBudgetPlan,
  planWithinBudget,
  refusedRecord,
} from '../downloads/budget';
import { downloadRuntimeOnce } from '../downloads/engine';
import { ensureController } from '../downloads/ensure-runtime';
import { downloadHistoryOnce } from '../downloads/history-runtime';
import { describeBatch, runBatch } from '../library/batch';
import { allChosen, chosenRows, toggleEvery, toggleOne } from '../library/selection';
import { player } from '../player';
import { queueFrom } from '../player/queue';
import { useVisibleQueue } from '../player/visible-queue';
import { sharePlaylistExport } from '../services/playlist-export';
import { AddSongs } from './add-songs';
import { BACK, useBack } from './back';
import { EditLink } from './edit-link';
import { useLibrary, useVisibleView } from './library-context';
import { PlaylistPicker } from './playlist-picker';
import { SelectionBar } from './selection-bar';
import { Prompt, Sheet, SheetAction } from './sheet';
import { SongActionsSheet } from './song-actions';
import { C, S } from './theme';

type Editing = { song: SongData; field: 'name' | 'artist' } | null;

export function PlaylistDetail({
  visible,
  id,
  onBack,
}: { visible: boolean; id: string; onBack: () => void }) {
  const { library, boot, changed } = useLibrary();
  const view = useVisibleView(visible);
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [acting, setActing] = useState<SongData | null>(null);
  // The same tick model as the songs tab (`library/selection.ts`), keyed by
  // song id. What differs here is one action: 移出歌单, which is not delete.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [addingTo, setAddingTo] = useState<readonly SongData[] | null>(null);
  const [confirmingMany, setConfirmingMany] = useState(false);
  /** The three screens the ⋮ menu delegates to whoever is showing it (0.1.1 ⑩). */
  const [editing, setEditing] = useState<Editing>(null);
  const [confirming, setConfirming] = useState<SongData | null>(null);
  const [linking, setLinking] = useState<SongData | null>(null);
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
    visible,
  );

  const rows = useMemo(
    () => (detail?.songs ?? []).map((song) => ({ ...song, key: song.id })),
    [detail?.songs],
  );
  const picked = useMemo(() => chosenRows(rows, chosen), [rows, chosen]);
  const leaveSelection = useCallback(() => setChosen(new Set()), []);

  // 0.1.1 ④, and it sits INSIDE the screen the shell registers for: a
  // selection is the innermost layer, so back leaves the selection before it
  // leaves the playlist.
  // `&& visible`: mounted is no longer the same as on screen (`shell.tsx`).
  useBack(
    selecting && visible,
    () => {
      leaveSelection();
      return true;
    },
    BACK.selection,
  );

  // A Modal outlives the pane behind it (`songs-tab.tsx` says why).
  useEffect(() => {
    if (visible) return;
    setRenaming(false);
    setAdding(false);
    setActing(null);
    setEditing(null);
    setConfirming(null);
    setLinking(null);
    setAddingTo(null);
    setConfirmingMany(false);
  }, [visible]);

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
    setEditing(null);
    setConfirming(null);
    setLinking(null);
    changed();
  };

  const batch = async (verb: string, act: (songId: string) => Promise<void> | void) => {
    const ids = picked.map((song) => song.id);
    setBusy(true);
    const outcome = await runBatch(ids, act);
    setBusy(false);
    leaveSelection();
    changed();
    ToastAndroid.show(describeBatch(verb, outcome), ToastAndroid.SHORT);
  };

  /**
   * 全部下载 — as much of this playlist as fits (0.1.1 ⑤).
   *
   * 🔴 IT STOPS AT THE CACHE LIMIT AND SAYS SO. It does not make room: the
   * songs it could not take get a row in 下载记录 carrying the reason, and
   * going past the limit is a person's decision taken by tapping 重下 there
   * (`downloads/budget.ts`).
   *
   * The measurements are taken HERE, at the moment of the tap, because both
   * of them move: the disk is walked for what every library on this device
   * weighs, and what a second of audio costs is measured off the songs that
   * are already here rather than guessed.
   */
  const downloadAll = (): void => {
    if (detail === null) return;
    const runtime = downloadRuntimeOnce(boot);
    const limitMb = readCacheLimitMb(boot.deviceSettings);
    const usage = readDeviceUsage({
      statusHere: (options) => view.cacheStatus(options),
      options: { ...runtime.cache.options(), limitBytes: limitMb * MIB },
      workspace: boot.workspace,
    });
    const plan = planWithinBudget(detail.songs, {
      usedBytes: usage.usedBytes,
      limitBytes: limitMb * MIB,
      // Measured over the WHOLE library rather than this playlist: a list
      // whose two downloaded songs happen to be short would otherwise set the
      // price for everything else in it.
      bytesPerSecond: bytesPerSecondOf(view.songs({}).songs),
    });
    for (const song of plan.queue) {
      try {
        runtime.engine.enqueueEnsureFile(song.id);
      } catch (err) {
        // A full queue, or a song that went away while the tap was in flight.
        // The engine's own sentence, and the rest of the batch still goes.
        ToastAndroid.show(err instanceof Error ? err.message : '没能排上队', ToastAndroid.SHORT);
        break;
      }
    }
    if (plan.refused.length > 0) {
      const at = Date.now();
      downloadHistoryOnce(boot).add(plan.refused.map((song) => refusedRecord(song, limitMb, at)));
    }
    ToastAndroid.show(describeBudgetPlan(plan), ToastAndroid.SHORT);
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
          <Pressable
            style={styles.newButton}
            onPress={downloadAll}
            accessibilityRole="button"
            accessibilityLabel="全部下载"
          >
            <Text style={styles.newLabel}>全部下载</Text>
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
              style={styles.detailRow}
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
                {/* 🔴 THE SAME WORDS THE 歌曲 TAB USES. This screen draws its
                    own row rather than `SongRow` (backlog C12), and the two
                    drifted: a song synced from another device has its metadata
                    and no audio, and in here nothing said so — the row looked
                    exactly like a song that was ready to play. */}
                {item.has_file === false ? ' · 需要下载' : ''}
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

      {/* The SAME menu the 歌曲 tab shows, plus the one entry that only means
          something in here (0.1.1 ⑩). What it used to be was 移出歌单 alone. */}
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
          onRemove={() => write(() => library.removePlaylistSong(id, acting.id))}
          onClose={() => setActing(null)}
        />
      )}

      {confirming !== null && (
        // A delete takes the audio with it, and on a phone there is no undo
        // and no trash — so it asks. 移出歌单 above does not, because it is
        // the one action on this screen that can be done again backwards.
        <Sheet
          title={`删除《${confirming.name}》？`}
          onClose={() => {
            setConfirming(null);
            setActing(null);
          }}
        >
          <SheetAction
            label="删除，连同它的文件"
            danger
            onPress={() => {
              void library.deleteSong(confirming.id).then(() => write(() => undefined));
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
          onClose={() => {
            setEditing(null);
            setActing(null);
          }}
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
            setActing(null);
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
  // The separator belongs to the LINE, not to the tappable part: with it on
  // the pressable it stopped where the text stopped, and the ⋮ hung off the
  // end of a line that had already been drawn (user, 2026-08-25).
  rowLine: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  /** The detail row's tappable half. `flex: 1` is what pushes ⋮ to the edge. */
  detailRow: { flex: 1, paddingVertical: 10, paddingHorizontal: S.pad },
  rowMenu: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  rowMenuGlyph: { color: C.muted, fontSize: 20 },
  rowNameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName: { color: C.text, fontSize: 16, flexShrink: 1 },
  // The ticked row — the surface tone, never the amber: that one is the
  // playing row's and the two must stay tellable apart (decision g).
  rowChosen: { backgroundColor: C.surface },
  rowMeta: { color: C.faint, fontSize: 12, marginTop: 2 },
  empty: { color: C.faint, fontSize: 14, padding: S.pad },
});
