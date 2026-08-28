// The full screen: lyrics, a progress bar you can drag, and the transport
// (N3c, decision c — a Modal, not a navigation stack).
//
// The progress bar is `PanResponder`, which ships with React Native. A slider
// package would have been a fourth native dependency for one control, and this
// batch has kept the "no gesture stack" line that N2f drew — `PanResponder` is
// touch arithmetic, not a gesture library.
//
// While a drag is in progress the bar shows the FINGER, not the player: a
// position that jumped back to the player's every 500ms would fight the thumb.

import { currentLrcIndex } from '@lark/shared';
import type { PlayMode } from '@lark/shared';
import { PLAY_MODE_LABELS, nextPlayMode } from '@lark/shared';
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ListMusic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
} from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import { player, usePlayback } from '../player';
import { useLibrary } from './library-context';
import { LYRIC_LINE_HEIGHT, lyricsPadding, targetOffset } from './lyrics-scroll';
import { skip } from './minibar';
import { Progress } from './progress';
import { C, S } from './theme';

/** The desktop's step, so a song nudged on one end reads the same on the other. */
const OFFSET_STEP_SECONDS = 0.5;

const MODE_ICONS: Record<PlayMode, typeof Repeat> = {
  sequential: ArrowRight,
  'repeat-all': Repeat,
  'repeat-one': Repeat1,
  shuffle: Shuffle,
};

export function PlayerScreen({ onClose, onQueue }: { onClose: () => void; onQueue: () => void }) {
  const name = usePlayback((state) => state.song?.name ?? null);
  const artist = usePlayback((state) => state.song?.artist ?? '');
  const playing = usePlayback((state) => state.playing);
  const mode = usePlayback((state) => state.mode);
  const duration = usePlayback((state) => state.duration);
  const time = usePlayback((state) => state.currentTime);
  const lyrics = usePlayback((state) => state.lyrics);
  const offset = usePlayback((state) => state.song?.lyrics_offset ?? 0);
  const songId = usePlayback((state) => state.song?.id ?? null);

  const index = lyrics.length === 0 ? -1 : currentLrcIndex(lyrics, time, offset);
  const ModeIcon = MODE_ICONS[mode];

  if (name === null) return null;

  return (
    <Modal transparent={false} animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.screen}>
        <Pressable style={styles.header} onPress={onClose} accessibilityRole="button">
          <Text style={styles.collapse}>收起</Text>
        </Pressable>

        <Text style={styles.name} numberOfLines={2}>
          {name}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {artist === '' ? '未知歌手' : artist}
        </Text>

        <Lyrics lines={lyrics} index={index} />

        {/* Only where there is something to shift. The desktop shows this row
            whatever the song has, but it lives in a fixed-height strip beside
            other controls; here it would be a number under 「这首歌没有歌词」
            explaining nothing. */}
        {lyrics.length > 0 && songId !== null && <Offset songId={songId} offset={offset} />}

        <Progress duration={duration} time={time} />

        <View style={styles.transport}>
          <Pressable
            style={styles.side}
            onPress={() => void player.setMode(nextPlayMode(mode))}
            accessibilityRole="button"
            accessibilityLabel={`播放模式：${PLAY_MODE_LABELS[mode]}`}
          >
            <ModeIcon size={20} color={C.muted} />
          </Pressable>
          <Pressable
            style={styles.control}
            onPress={() => void back()}
            accessibilityRole="button"
            accessibilityLabel="上一首"
          >
            <SkipBack size={26} color={C.text} fill={C.text} />
          </Pressable>
          <Pressable
            style={styles.control}
            onPress={() => void player.toggle()}
            accessibilityRole="button"
            accessibilityLabel={playing ? '暂停' : '播放'}
          >
            {playing ? (
              <Pause size={34} color={C.text} fill={C.text} />
            ) : (
              <Play size={34} color={C.text} fill={C.text} />
            )}
          </Pressable>
          <Pressable
            style={styles.control}
            onPress={() => void skip()}
            accessibilityRole="button"
            accessibilityLabel="下一首"
          >
            <SkipForward size={26} color={C.text} fill={C.text} />
          </Pressable>
          <Pressable
            style={styles.side}
            onPress={onQueue}
            accessibilityRole="button"
            accessibilityLabel="播放队列"
          >
            <ListMusic size={20} color={C.muted} />
          </Pressable>
        </View>

        <Text style={styles.modeLabel}>{PLAY_MODE_LABELS[mode]}</Text>
      </View>
    </Modal>
  );
}

/**
 * The lyric offset, written straight to the song.
 *
 * `lyrics_offset` in the database is the one source of truth — which is also
 * why `parseLrc` ignores any `[offset:]` inside the file (M4-13④) — so this
 * writes it and says the library changed. Everything that reads the current
 * line (this screen, the mini bar, the Bluetooth title) is downstream of that
 * one signal and moves together.
 *
 * The value is on screen ALWAYS rather than as a badge that fades: the
 * desktop's transient badge exists because it has nowhere to put a number,
 * and a row that is already here can simply hold it.
 */
function Offset({ songId, offset }: { songId: string; offset: number }) {
  const { library, changed } = useLibrary();
  const adjust = (delta: number): void => {
    // One decimal: the buttons move in halves and float noise has no business
    // reaching the database (the desktop rounds in the same place).
    library.updateSong(songId, { lyrics_offset: Number((offset + delta).toFixed(1)) });
    changed();
  };
  return (
    <View style={styles.offset}>
      <Pressable
        style={styles.offsetButton}
        onPress={() => adjust(-OFFSET_STEP_SECONDS)}
        accessibilityRole="button"
        accessibilityLabel="歌词后移 0.5 秒"
      >
        <ChevronLeft size={20} color={C.muted} />
      </Pressable>
      <Text style={styles.offsetValue}>
        歌词 {offset > 0 ? '+' : ''}
        {offset.toFixed(1)}s
      </Text>
      <Pressable
        style={styles.offsetButton}
        onPress={() => adjust(OFFSET_STEP_SECONDS)}
        accessibilityRole="button"
        accessibilityLabel="歌词前移 0.5 秒"
      >
        <ChevronRight size={20} color={C.muted} />
      </Pressable>
    </View>
  );
}

async function back(): Promise<void> {
  const decision = await player.prev();
  if (decision?.kind === 'reject') ToastAndroid.show('播放不了上一首', ToastAndroid.SHORT);
}

/**
 * The lyric list, following the line that is playing.
 *
 * Positions are MEASURED rather than computed from a line height: a long line
 * wraps, and a scroll offset built out of `index * 30` walks further away from
 * the truth with every wrapped line above it. `onLayout` gives the real y of
 * each line, and `lyrics-scroll.ts` turns it into an offset that puts that
 * line in the MIDDLE of the screen — which the last line could not reach until
 * the padding below it did (⑥).
 */
function Lyrics({
  lines,
  index,
}: { lines: readonly { time: number; text: string }[]; index: number }) {
  const scroller = useRef<ScrollView | null>(null);
  const tops = useRef<number[]>([]);
  const measuredFor = useRef(lines);
  const [height, setHeight] = useState(0);

  // ONE effect, so which of the two things happens first is written down
  // rather than left to the order they were declared in.
  //
  // The measurements belong to the song that produced them, and `index` moves
  // to the new song's first line while the ref still holds the old song's y
  // values — following those scrolls to wherever a line of the PREVIOUS song
  // used to be. Dropping them goes back to the top instead, which is where
  // line 0 sits now that the padding is half a screen; the new numbers arrive
  // through `onLayout` and the next line to play uses them.
  useEffect(() => {
    if (measuredFor.current !== lines) {
      measuredFor.current = lines;
      tops.current = [];
      scroller.current?.scrollTo({ y: 0, animated: false });
      return;
    }
    const y = targetOffset({
      tops: tops.current,
      index,
      viewportHeight: height,
      lineHeight: LYRIC_LINE_HEIGHT,
    });
    if (y === null) return;
    scroller.current?.scrollTo({ y, animated: true });
  }, [lines, index, height]);

  if (lines.length === 0) {
    return (
      <View style={styles.lyrics}>
        <Text style={styles.noLyrics}>这首歌没有歌词</Text>
      </View>
    );
  }

  return (
    <ScrollView
      ref={scroller}
      style={styles.lyrics}
      contentContainerStyle={lyricsPadding(height, LYRIC_LINE_HEIGHT)}
      // Android-only, and the point of it: the bar is a POSITION indicator on
      // a screen whose text is scrolling itself. One that appears only while a
      // finger is down tells you where you are exactly when you already know.
      persistentScrollbar
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
    >
      {lines.map((line, i) => (
        <Text
          key={`${line.time}-${i}`}
          style={[styles.lyricLine, i === index && styles.lyricCurrent]}
          onLayout={(event) => {
            tops.current[i] = event.nativeEvent.layout.y;
          }}
        >
          {line.text === '' ? '·' : line.text}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg, padding: S.pad, paddingTop: 24 },
  header: { alignSelf: 'flex-start', paddingVertical: 8, paddingRight: 16 },
  collapse: { color: C.muted, fontSize: 15 },
  name: { color: C.text, fontSize: 20, marginTop: 8 },
  artist: { color: C.faint, fontSize: 13, marginTop: 4 },
  lyrics: { flex: 1, marginTop: 16 },
  lyricLine: { color: C.faint, fontSize: 15, lineHeight: LYRIC_LINE_HEIGHT, textAlign: 'center' },
  lyricCurrent: { color: C.active, fontSize: 17 },
  noLyrics: { color: C.faint, fontSize: 14, textAlign: 'center', paddingVertical: 24 },
  offset: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  offsetButton: { width: 44, height: 36, alignItems: 'center', justifyContent: 'center' },
  offsetValue: { color: C.faint, fontSize: 12, minWidth: 84, textAlign: 'center' },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  side: { width: 44, height: 56, alignItems: 'center', justifyContent: 'center' },
  control: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  modeLabel: { color: C.faint, fontSize: 11, textAlign: 'center', paddingBottom: 8 },
});
