// The bar above the tabs, once something is playing (N3c) — or once something
// is on its way to being played (N4g).
//
// Three things and one of them is a button that opens a panel, because that is
// what "上拉 → 队列" turned out to mean: a dedicated control, not a gesture
// (decision d). No gesture stack in this app, still.
//
// The lyric line under the title is the same computation the Bluetooth title
// makes (N3d) — `currentLrcIndex` over the song's own offset — so the two
// cannot drift into showing different lines of the same song.
//
// THE FETCHING ROW IS WHY THIS BAR NOW HAS TWO REASONS TO EXIST. Tapping a
// song with no file starts a download and plays it when it lands (§2.9), which
// can take a minute — and for that minute the only evidence that the tap was
// heard is here. It sits ABOVE what is playing, because what is playing is
// about to be replaced by it, and it carries the one control that matters
// while waiting: 取消, which drops the play intent and stops the download.

import { currentLrcIndex } from '@lark/shared';
import { ListMusic, Pause, Play, SkipForward, X } from 'lucide-react-native';
import { useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import { type EnsureWait, ensureController } from '../downloads/ensure-runtime';
import { player, usePlayback } from '../player';
import { Progress } from './progress';
import { C, S } from './theme';

const REFUSALS: Record<string, string> = {
  'not-in-queue': '这首歌不在当前播放的歌单里',
  'no-file': '下一首还没有文件',
  'no-other-playable': '没有其它可以播放的歌曲',
};

/** What the ensure controller is waiting for, or `null`. */
function useEnsureWait(): EnsureWait | null {
  const ensure = ensureController();
  return useSyncExternalStore(ensure.subscribe, ensure.getState);
}

export function MiniBar({ onOpen, onQueue }: { onOpen: () => void; onQueue: () => void }) {
  const name = usePlayback((state) => state.song?.name ?? null);
  const waiting = useEnsureWait();

  if (name === null && waiting === null) return null;

  return (
    <View style={styles.bar}>
      {waiting !== null && <Fetching waiting={waiting} />}
      {name !== null && <Playing name={name} onOpen={onOpen} onQueue={onQueue} />}
    </View>
  );
}

/** 正在获取《…》 — a tap that has been heard and is waiting on the network. */
function Fetching({ waiting }: { waiting: EnsureWait }) {
  return (
    <View style={styles.fetchRow}>
      <Text style={styles.fetchText} numberOfLines={1}>
        正在获取《{waiting.name}》
      </Text>
      <Pressable
        style={styles.control}
        onPress={() => ensureController().cancel()}
        accessibilityRole="button"
        accessibilityLabel="取消获取"
      >
        <X size={18} color={C.muted} />
      </Pressable>
    </View>
  );
}

function Playing({
  name,
  onOpen,
  onQueue,
}: { name: string; onOpen: () => void; onQueue: () => void }) {
  const playing = usePlayback((state) => state.playing);
  const line = usePlayback(currentLine);
  const time = usePlayback((state) => state.currentTime);
  const duration = usePlayback((state) => state.duration);

  return (
    <>
      {/* Three rows, because the one row it started as had to hold a title, a
          lyric and three controls, and the lyric is the line that gets long. */}
      <View style={styles.top}>
        <Pressable
          style={styles.body}
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={`正在播放 ${name}`}
        >
          <Text style={styles.name} numberOfLines={1}>
            {name}
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

      {/* The row STAYS when there is no line — an empty one, holding its own
          height. A bar that grew and shrank as songs with and without lyrics
          followed each other moved the tab bar under the thumb. What is gone
          is the old fallback text: "第 3 / 7 首" was answering a question
          nobody asks of this row, and the queue panel answers it better. */}
      <Pressable
        style={styles.lineRow}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel="展开播放页"
      >
        <Text style={styles.line} numberOfLines={1}>
          {line ?? ''}
        </Text>
      </Pressable>

      <View style={styles.progressRow}>
        <Progress duration={duration} time={time} compact />
      </View>
    </>
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

function currentLine(state: {
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

/** Tightened twice by hand: the lyric sat further from its title than the
 *  three rows are tall. */
const ROW_GAP = 3;
const LINE_HEIGHT = 16;

const styles = StyleSheet.create({
  bar: {
    paddingHorizontal: S.pad,
    paddingTop: 6,
    paddingBottom: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    backgroundColor: C.surface,
  },
  top: { flexDirection: 'row', alignItems: 'center' },
  body: { flex: 1, marginRight: 8 },
  name: { color: C.active, fontSize: 16 },
  fetchRow: { flexDirection: 'row', alignItems: 'center' },
  fetchText: { flex: 1, color: C.muted, fontSize: 13 },
  // The three rows sit ROW_GAP apart, top to bottom. The lyric used to hug the
  // progress bar because its own padding was smaller than the bar's margin.
  lineRow: { marginTop: ROW_GAP, height: LINE_HEIGHT },
  line: { color: C.faint, fontSize: 12, lineHeight: LINE_HEIGHT, textAlign: 'center' },
  control: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  progressRow: { marginTop: ROW_GAP },
});
