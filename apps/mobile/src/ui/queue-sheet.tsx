// What is playing, and where in it we are (N3c, decisions d and o).
//
// The panel reads the queue's ids through the library, so a rename shows and a
// deleted song is simply not here — the ids are the queue, the rows are the
// library's answer about them today.
//
// Tapping a row plays it. A list of songs that could not be tapped would be a
// list nobody would tap twice.

import type { PlayMode, SongData } from '@lark/shared';
import { PLAY_MODE_LABELS, nextPlayMode } from '@lark/shared';
import { ArrowRight, Repeat, Repeat1, Shuffle } from 'lucide-react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { player, usePlayback } from '../player';
import { resolveQueue } from '../player/queue';
import { useLibrary } from './library-context';
import { C, S } from './theme';

export function QueueSheet({ onClose }: { onClose: () => void }) {
  const { view } = useLibrary();
  const queue = usePlayback((state) => state.queue);
  const currentId = usePlayback((state) => state.song?.id ?? null);
  const mode = usePlayback((state) => state.mode);
  const ModeIcon = MODE_ICONS[mode];

  const songs: readonly SongData[] =
    queue === null
      ? []
      : resolveQueue(
          queue,
          queue.source.kind === 'all' ? view.songs().songs : view.playlistSongs(queue.source.id),
        );
  const index = songs.findIndex((song) => song.id === currentId);

  return (
    <View style={styles.sheet}>
      <View style={styles.head}>
        <Text style={styles.title}>播放队列</Text>
        <Text style={styles.count}>
          {index < 0 ? `${songs.length} 首` : `第 ${index + 1} / ${songs.length} 首`}
        </Text>
      </View>
      {/* The mode belongs beside the queue, not only on the full screen: "what
          plays after this" is the question the queue is open to answer. */}
      <Pressable
        style={styles.mode}
        onPress={() => void player.setMode(nextPlayMode(mode))}
        accessibilityRole="button"
        accessibilityLabel={`播放模式：${PLAY_MODE_LABELS[mode]}`}
      >
        <ModeIcon size={16} color={C.muted} />
        <Text style={styles.modeLabel}>{PLAY_MODE_LABELS[mode]}</Text>
      </Pressable>
      <FlatList
        data={songs}
        keyExtractor={(song) => song.id}
        style={styles.list}
        renderItem={({ item, index: position }) => (
          <Pressable
            style={styles.row}
            onPress={() => {
              if (queue !== null) void player.play(item, queue);
              onClose();
            }}
            accessibilityRole="button"
            accessibilityLabel={`播放 ${item.name}`}
          >
            <Text style={styles.position}>{position + 1}</Text>
            <Text
              style={[styles.name, item.id === currentId && styles.nameCurrent]}
              numberOfLines={1}
            >
              {item.name}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>队列是空的</Text>}
      />
      <Pressable style={styles.close} onPress={onClose} accessibilityRole="button">
        <Text style={styles.closeLabel}>关闭</Text>
      </Pressable>
    </View>
  );
}

const MODE_ICONS: Record<PlayMode, typeof Repeat> = {
  sequential: ArrowRight,
  'repeat-all': Repeat,
  'repeat-one': Repeat1,
  shuffle: Shuffle,
};

const styles = StyleSheet.create({
  sheet: { flexShrink: 1, backgroundColor: C.surface, borderRadius: 12, padding: S.pad },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  title: { color: C.text, fontSize: 16 },
  count: { color: C.faint, fontSize: 12 },
  mode: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingRight: 12,
  },
  modeLabel: { color: C.muted, fontSize: 13, marginLeft: 6 },
  list: { flexShrink: 1, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  position: { color: C.faint, fontSize: 12, width: 28 },
  name: { color: C.text, fontSize: 15, flex: 1 },
  nameCurrent: { color: C.active },
  empty: { color: C.faint, fontSize: 14, paddingVertical: 12 },
  close: { paddingVertical: 12, alignItems: 'center' },
  closeLabel: { color: C.muted, fontSize: 15 },
});
