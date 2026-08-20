// The bar above the tabs, once something is playing (N3c).
//
// Three things and one of them is a button that opens a panel, because that is
// what "上拉 → 队列" turned out to mean: a dedicated control, not a gesture
// (decision d). No gesture stack in this app, still.
//
// The lyric line under the title is the same computation the Bluetooth title
// will be in N3d — `currentLrcIndex` over the song's own offset — so the two
// cannot drift into showing different lines of the same song.

import { currentLrcIndex } from '@lark/shared';
import { ListMusic, Pause, Play, SkipForward } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import { player, usePlayback } from '../player';
import { C, S } from './theme';

const REFUSALS: Record<string, string> = {
  'not-in-queue': '这首歌不在当前播放的歌单里',
  'no-file': '下一首还没有文件，下载在 N4 开放',
  'no-other-playable': '没有其它可以播放的歌曲',
};

export function MiniBar({ onOpen, onQueue }: { onOpen: () => void; onQueue: () => void }) {
  const name = usePlayback((state) => state.song?.name ?? null);
  const playing = usePlayback((state) => state.playing);
  const line = usePlayback(currentLine);
  const [queued, total] = [usePlayback(positionInQueue), usePlayback(queueLength)];

  if (name === null) return null;

  return (
    <View style={styles.bar}>
      <Pressable
        style={styles.body}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`正在播放 ${name}`}
      >
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.line} numberOfLines={1}>
          {line ?? `第 ${queued} / ${total} 首`}
        </Text>
      </Pressable>
      <Pressable
        style={styles.control}
        onPress={() => void player.toggle()}
        accessibilityRole="button"
        accessibilityLabel={playing ? '暂停' : '播放'}
      >
        {playing ? (
          <Pause size={22} color={C.text} fill={C.text} />
        ) : (
          <Play size={22} color={C.text} fill={C.text} />
        )}
      </Pressable>
      <Pressable
        style={styles.control}
        onPress={() => void skip()}
        accessibilityRole="button"
        accessibilityLabel="下一首"
      >
        <SkipForward size={22} color={C.text} fill={C.text} />
      </Pressable>
      <Pressable
        style={styles.control}
        onPress={onQueue}
        accessibilityRole="button"
        accessibilityLabel="播放队列"
      >
        <ListMusic size={22} color={C.text} />
      </Pressable>
    </View>
  );
}

/**
 * Decision n: a button the user pressed that went nowhere has to say so. A
 * song that simply ended does not — that is what the pause state is for.
 */
export async function skip(): Promise<void> {
  const decision = await player.next();
  if (decision?.kind === 'reject') {
    ToastAndroid.show(REFUSALS[decision.reason] ?? '播放不了下一首', ToastAndroid.SHORT);
  }
}

export function currentLine(state: {
  lyrics: readonly { time: number; text: string }[];
  currentTime: number;
  song: { lyrics_offset: number } | null;
}): string | null {
  if (state.lyrics.length === 0 || state.song === null) return null;
  const index = currentLrcIndex(state.lyrics, state.currentTime, state.song.lyrics_offset);
  const text = state.lyrics[index]?.text ?? '';
  // An interlude is a timed blank; showing nothing is right, showing the line
  // before it is not.
  return text === '' ? null : text;
}

const positionInQueue = (state: {
  queue: { songIds: readonly string[] } | null;
  song: { id: string } | null;
}): number => {
  if (state.queue === null || state.song === null) return 0;
  return state.queue.songIds.indexOf(state.song.id) + 1;
};

const queueLength = (state: { queue: { songIds: readonly string[] } | null }): number =>
  state.queue?.songIds.length ?? 0;

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.pad,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    backgroundColor: C.surface,
  },
  body: { flex: 1, marginRight: 8 },
  name: { color: C.active, fontSize: 14 },
  line: { color: C.faint, fontSize: 12, marginTop: 2 },
  control: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
