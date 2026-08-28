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
import {
  FOLLOWING,
  type FollowState,
  LYRIC_LINE_HEIGHT,
  isFollowing,
  lineAtCentre,
  lyricsPadding,
  onDragBegin,
  onScrollSettled,
  onSeek,
  onTick,
  targetOffset,
} from './lyrics-scroll';
import { skip } from './minibar';
import { Progress, clock } from './progress';
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

        <Lyrics lines={lyrics} index={index} offset={offset} />

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
 * The lyric list, following the line that is playing — or the finger (⑦).
 *
 * Positions are MEASURED rather than computed from a line height: a long line
 * wraps, and a scroll offset built out of `index * 30` walks further away from
 * the truth with every wrapped line above it. `onLayout` gives the real y of
 * each line, and `lyrics-scroll.ts` turns it into an offset that puts that
 * line in the MIDDLE of the screen — which the last line could not reach until
 * the padding below it did (⑥).
 *
 * Scrolling it by hand hands the list over: a rule appears across the middle
 * naming the line under it, tapping the triangle seeks there, and letting go
 * gives the song the list back a few seconds later. The shape is the one every
 * player on this phone already uses; what is ours is that the playing line
 * STAYS highlighted underneath, because the rule answers a different question.
 *
 * It stays a `ScrollView` rather than becoming a `FlatList`: lyrics are rarely
 * two hundred lines, and the `onLayout` measurement above — the whole reason
 * wrapped lines land correctly — does not exist for rows a list has recycled.
 */
function Lyrics({
  lines,
  index,
  offset,
}: {
  lines: readonly { time: number; text: string }[];
  index: number;
  /** `lyrics_offset`: the display leads the audio by this much. */
  offset: number;
}) {
  const scroller = useRef<ScrollView | null>(null);
  const tops = useRef<number[]>([]);
  const measuredFor = useRef(lines);
  const [height, setHeight] = useState(0);
  const [follow, setFollow] = useState<FollowState>(FOLLOWING);
  /** Which line the rule is on. Only read while the finger has the list. */
  const [centre, setCentre] = useState<number | null>(null);
  const manual = !isFollowing(follow);

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
    // The list belongs to whoever is holding it. This is also what brings it
    // back: `follow` returning to `follow` re-runs the effect, and the scroll
    // to the playing line IS the return.
    if (!isFollowing(follow)) return;
    const y = targetOffset({
      tops: tops.current,
      index,
      viewportHeight: height,
      lineHeight: LYRIC_LINE_HEIGHT,
    });
    if (y === null) return;
    scroller.current?.scrollTo({ y, animated: true });
  }, [lines, index, height, follow]);

  // 🔵 A JS TIMER, AND THAT IS CORRECT HERE. The guard that bans them covers
  // `src/player/`, and its question is "is this wait still meaningful with the
  // screen off" — nobody is reading lyrics behind a dark screen, so the answer
  // is no. Same reasoning that DELETED N4f-2's grace period rather than moving
  // it to native: a wait nobody is waiting for does not need to survive.
  useEffect(() => {
    if (follow.kind !== 'settling') return;
    const timer = setTimeout(
      () => setFollow((state) => onTick(state, Date.now())),
      Math.max(0, follow.until - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [follow]);

  /** The tapped line becomes the playing line, and the song has the list back. */
  const seekToCentre = async (line: number): Promise<void> => {
    const target = lines[line];
    if (target === undefined) return;
    // `currentLrcIndex` compares `time + offset`, so going the other way is a
    // subtraction. Awaited before following again: the store writes the new
    // position as part of the seek, so by then `index` is the line that was
    // tapped and the list scrolls there once instead of going back first.
    await player.seek(Math.max(0, target.time - offset));
    setFollow(onSeek());
  };

  if (lines.length === 0) {
    return (
      <View style={styles.lyrics}>
        <Text style={styles.noLyrics}>这首歌没有歌词</Text>
      </View>
    );
  }

  return (
    <View style={styles.lyrics}>
      <ScrollView
        ref={scroller}
        style={styles.lyricsScroll}
        contentContainerStyle={lyricsPadding(height, LYRIC_LINE_HEIGHT)}
        // Android-only, and the point of it: the bar is a POSITION indicator on
        // a screen whose text is scrolling itself. One that appears only while a
        // finger is down tells you where you are exactly when you already know.
        persistentScrollbar
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        onScrollBeginDrag={() => {
          // Dropped rather than kept: it names a line from where the list was
          // the LAST time a finger was on it, and one frame of the wrong
          // timestamp is worse than one frame of nothing.
          setCentre(null);
          setFollow(onDragBegin());
        }}
        onScrollEndDrag={() => setFollow((state) => onScrollSettled(state, Date.now()))}
        onMomentumScrollEnd={() => setFollow((state) => onScrollSettled(state, Date.now()))}
        scrollEventThrottle={16}
        onScroll={(event) => {
          // Every frame of a drag, and none of a scroll the song asked for —
          // the rule is not on screen then, and this would be a re-render per
          // frame of every automatic scroll.
          if (!manual) return;
          setCentre(lineAtCentre(tops.current, event.nativeEvent.contentOffset.y, height));
        }}
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

      {/* `box-none` all the way down: the rule lies across the list, and
          everything but the triangle has to let a drag through to it. */}
      {manual && centre !== null && lines[centre] !== undefined && (
        <View style={styles.centre} pointerEvents="box-none">
          <View style={styles.centreRow} pointerEvents="box-none">
            <Text style={styles.centreTime}>
              {clock(Math.max(0, (lines[centre]?.time ?? 0) - offset))}
            </Text>
            <View style={styles.centreRule} />
            <Pressable
              style={styles.centreSeek}
              onPress={() => void seekToCentre(centre)}
              accessibilityRole="button"
              accessibilityLabel="跳到这一句"
            >
              <Play size={16} color={C.text} fill={C.text} />
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg, padding: S.pad, paddingTop: 24 },
  header: { alignSelf: 'flex-start', paddingVertical: 8, paddingRight: 16 },
  collapse: { color: C.muted, fontSize: 15 },
  name: { color: C.text, fontSize: 20, marginTop: 8 },
  artist: { color: C.faint, fontSize: 13, marginTop: 4 },
  lyrics: { flex: 1, marginTop: 16 },
  lyricsScroll: { flex: 1 },
  centre: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, justifyContent: 'center' },
  centreRow: { flexDirection: 'row', alignItems: 'center', gap: S.gap },
  centreTime: { color: C.muted, fontSize: 11, width: 34 },
  centreRule: {
    flex: 1,
    borderTopWidth: 1,
    borderStyle: 'dashed',
    borderColor: C.border,
  },
  centreSeek: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
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
