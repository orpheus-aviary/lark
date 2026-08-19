// The 歌单 tab: the list, and one detail screen (N2f, criteria 14 and 15).
//
// The virtual `all` is FIRST and comes from the service, not from here — a
// list that differed between front ends is the M6 divergence the
// LibraryContract exists to pin. It is readable and never writable, so the
// detail screen offers no actions for it.
//
// NO DRAG REORDER (subplan §8.3, user's call): long-press is easy to trigger
// by accident and mainstream mobile music apps do not offer it either. The
// service's `reorderPlaylist` is untouched and stays covered by the contract;
// what is missing is the handle, and with it the three native dependencies a
// draggable list would have cost.

import type { PlaylistData, SongData } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLibrary } from './library-context';
import { Prompt, Sheet, SheetAction } from './sheet';
import { C, S } from './theme';

export function PlaylistsTab() {
  const [openId, setOpenId] = useState<string | null>(null);
  return openId === null ? (
    <PlaylistList onOpen={setOpenId} />
  ) : (
    <PlaylistDetail id={openId} onBack={() => setOpenId(null)} />
  );
}

function PlaylistList({ onOpen }: { onOpen: (id: string) => void }) {
  const { library, view, changed } = useLibrary();
  const [creating, setCreating] = useState(false);
  const playlists = useMemo(() => view.playlists(), [view]);

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
            <Text style={styles.rowName}>{label(item)}</Text>
            <Text style={styles.rowMeta}>{item.song_count} 首</Text>
          </Pressable>
        )}
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

  const virtual = id === VIRTUAL_ALL_PLAYLIST_ID;
  const detail = useMemo(() => {
    const playlist = view.playlists().find((p) => p.id === id) ?? null;
    return playlist === null ? null : { playlist, songs: view.playlistSongs(id) };
  }, [view, id]);

  // The playlist this screen was opened for is gone — deleted from here, or by
  // a peer. Going back is the only honest thing left to render.
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
      <Text style={styles.detailTitle}>{label(detail.playlist)}</Text>

      {!virtual && (
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
            onPress={() => write(() => library.deletePlaylist(id))}
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
          <Pressable
            style={styles.row}
            onPress={() => (virtual ? undefined : setActing(item))}
            accessibilityRole="button"
          >
            <Text style={styles.rowName} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={styles.rowMeta} numberOfLines={1}>
              {item.artist === '' ? '未知歌手' : item.artist}
            </Text>
          </Pressable>
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

/** The virtual playlist's id IS its name; a real one carries its own. */
const label = (playlist: PlaylistData): string =>
  playlist.id === VIRTUAL_ALL_PLAYLIST_ID ? '全部歌曲' : playlist.name;

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
