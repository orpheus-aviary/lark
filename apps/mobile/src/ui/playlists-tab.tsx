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
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
} from 'react-native';
import { player } from '../player';
import { queueFrom } from '../player/queue';
import { useLibrary } from './library-context';
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
    () => view.playlists().filter((playlist) => playlist.id !== VIRTUAL_ALL_PLAYLIST_ID),
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

  const detail = useMemo(() => {
    const playlist = view.playlists().find((p) => p.id === id) ?? null;
    return playlist === null ? null : { playlist, songs: view.playlistSongs(id) };
  }, [view, id]);

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

  return (
    <View style={styles.fill}>
      <Back onPress={onBack} />
      <Text style={styles.detailTitle}>{detail.playlist.name}</Text>

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

      <FlatList
        data={detail.songs}
        keyExtractor={(song) => song.id}
        renderItem={({ item }) => (
          // The row is a play target and the menu is its own button — the same
          // shape as the 歌曲 tab, decided by hand-testing in N2f. What differs
          // is the queue: playing from here plays THIS playlist.
          <View style={styles.rowLine}>
            <Pressable
              style={styles.row}
              onPress={() => {
                if (item.has_file === false) {
                  ToastAndroid.show('这首还没有文件，下载在 N4 开放', ToastAndroid.SHORT);
                  return;
                }
                void player.play(item, queueFrom({ kind: 'playlist', id }, detail.songs));
              }}
              accessibilityRole="button"
              accessibilityLabel={`播放 ${item.name}`}
            >
              <Text style={styles.rowName} numberOfLines={1}>
                {item.name}
              </Text>
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

      {adding && (
        <AddSongs
          memberIds={new Set(detail.songs.map((song) => song.id))}
          onClose={() => setAdding(false)}
          onAdd={(songId) => write(() => library.addPlaylistSongs(id, [songId]))}
        />
      )}
    </View>
  );
}

/** Everything not already in the playlist. Adding what is there is a no-op nobody asked for. */
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
  const candidates = useMemo(
    () => view.songs().songs.filter((song) => !memberIds.has(song.id)),
    [view, memberIds],
  );

  return (
    <Sheet title="加歌" onClose={onClose}>
      <ScrollView style={styles.picker}>
        {candidates.length === 0 ? (
          <Text style={styles.empty}>曲库里的歌都在这个歌单里了。</Text>
        ) : (
          candidates.map((song) => (
            <SheetAction key={song.id} label={song.name} onPress={() => onAdd(song.id)} />
          ))
        )}
      </ScrollView>
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
  rowName: { color: C.text, fontSize: 16 },
  rowMeta: { color: C.faint, fontSize: 12, marginTop: 2 },
  empty: { color: C.faint, fontSize: 14, padding: S.pad },
  picker: { maxHeight: 320 },
});
