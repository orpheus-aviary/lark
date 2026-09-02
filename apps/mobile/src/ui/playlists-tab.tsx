// The 歌单 tab: the list of playlists (N2f, criteria 14 and 15).
//
// The detail screen moved to `ui/playlist-detail.tsx` in 0.1.1 — see there for
// what grew it past a split.
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

import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import { shareLibraryExport } from '../services/playlist-export';
import { BACK, useBack } from './back';
import { ImportPlaylistScreen } from './import-playlist';
import { useLibrary, useVisibleView } from './library-context';
import { PlaylistDetail } from './playlist-detail';
import { Prompt } from './sheet';
import { C, S } from './theme';

/**
 * Which playlist is open is the SHELL's state, not this component's — see
 * `shell.tsx` for why it stays there now that tabs are no longer unmounted.
 */
export function PlaylistsTab({
  visible,
  openId,
  onOpen,
}: {
  visible: boolean;
  openId: string | null;
  onOpen: (id: string | null) => void;
}) {
  // 0.1.1 ④. The detail screen is the one screen in this app that is NOT a
  // `Modal`, so it was the one screen the back key left the app from. It is
  // registered HERE rather than inside the detail because this is where
  // "which playlist is open" can be unset.
  // `&& visible`: still mounted while another tab shows, and a playlist nobody
  // can see must not answer the back key.
  useBack(
    openId !== null && visible,
    () => {
      onOpen(null);
      return true;
    },
    BACK.screen,
  );
  return openId === null ? (
    <PlaylistList visible={visible} onOpen={onOpen} />
  ) : (
    <PlaylistDetail visible={visible} id={openId} onBack={() => onOpen(null)} />
  );
}

function PlaylistList({ visible, onOpen }: { visible: boolean; onOpen: (id: string) => void }) {
  const { library, changed } = useLibrary();
  const view = useVisibleView(visible);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  // A Modal outlives the pane behind it (`songs-tab.tsx` says why).
  useEffect(() => {
    if (visible) return;
    setCreating(false);
    setImporting(false);
  }, [visible]);
  const playlists = useMemo(
    // The virtual `all` is already gone: `library-context.tsx` drops it once,
    // for every screen, after the add page was found offering it as a download
    // target beside 「仅曲库」 (2026-08-24).
    () => view.playlists(),
    [view],
  );

  const exportLibrary = async (): Promise<void> => {
    try {
      const result = await shareLibraryExport(library);
      ToastAndroid.show(
        result.shared
          ? `已导出整个曲库（${result.songCount} 首）`
          : '这台设备没有可以接收文件的应用',
        ToastAndroid.SHORT,
      );
    } catch (err) {
      ToastAndroid.show(err instanceof Error ? err.message : '导出失败', ToastAndroid.SHORT);
    }
  };

  return (
    <View style={styles.fill}>
      <View style={styles.actions}>
        <Pressable
          style={styles.newButton}
          onPress={() => setCreating(true)}
          accessibilityRole="button"
        >
          <Text style={styles.newLabel}>新建歌单</Text>
        </Pressable>
        {/* Beside 新建, not in the add tab: that tab is "fetch new songs from a
            link", and this is "take somebody else's list". N6b. */}
        <Pressable
          style={styles.newButton}
          onPress={() => setImporting(true)}
          accessibilityRole="button"
        >
          <Text style={styles.newLabel}>导入歌单</Text>
        </Pressable>
        {/* N6c, criterion 102. The settings screen tells people that exporting
            is how a phone-only library survives an uninstall, and until this
            button existed that was only true of songs that happened to be in a
            playlist. */}
        <Pressable
          style={styles.newButton}
          onPress={() => void exportLibrary()}
          accessibilityRole="button"
        >
          <Text style={styles.newLabel}>导出曲库</Text>
        </Pressable>
      </View>

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

      {importing && <ImportPlaylistScreen onClose={() => setImporting(false)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap' },
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
  row: {
    paddingVertical: 10,
    paddingHorizontal: S.pad,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  rowName: { color: C.text, fontSize: 16, flexShrink: 1 },
  rowMeta: { color: C.faint, fontSize: 12, marginTop: 2 },
  empty: { color: C.faint, fontSize: 14, padding: S.pad },
});
