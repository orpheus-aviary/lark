// The progress bar, shared by the mini bar and the full screen (N3c).
//
// One component because there is one behaviour: tap or drag anywhere on the
// track to seek. It started as full-screen-only, on the theory that the mini
// bar's bar was a readout — but a readout you cannot touch is a tease when
// your thumb is already on it.
//
// `PanResponder` ships with React Native. A slider package would have been a
// fourth native dependency for one control, and this app still has no gesture
// stack (N2f drew that line; nothing since has needed to cross it).
//
// While a finger is down the bar shows the FINGER, not the player: a position
// that snapped back to the player's every 500ms would fight the thumb.
//
// THE GESTURE IS ANCHORED IN PAGE SPACE, and that is the second thing this
// bar had to learn. `locationX` was right on the touch DOWN — taps landed
// exactly where they were aimed — and wrong on every MOVE after it: dragging
// slid forward the moment it started and then tracked from there, so the bar
// followed the finger's displacement rather than the finger. The fix uses the
// one measurement known to be correct: at grant, `pageX - locationX` IS the
// track's left edge in window coordinates, computed synchronously and without
// asking anybody to measure anything. Every position after that is
// `pageX - origin`, which cannot drift because it never accumulates.
//
// THE CHILDREN ARE `pointerEvents="none"`, and that is load bearing.
// `locationX` is measured against the view the touch LANDED ON, not against
// the responder — so a tap that happened to hit the head, or the filled part
// of the rail, reported a few pixels inside that small child and seeked to
// nearly zero. The symptom is "tapping the bar jumps to the beginning, often",
// and the more accurate your aim at the current position, the more reliably it
// happened. With the children transparent to touch, the track is always the
// target and `locationX` means what the arithmetic below assumes.

import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { player } from '../player';
import { C } from './theme';

export const clock = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

export function Progress({
  duration,
  time,
  compact = false,
}: { duration: number; time: number; compact?: boolean }) {
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  // The responder is built once, so it reads its inputs through a ref rather
  // than closing over the render they belonged to.
  const box = useRef({ width: 0, duration: 0 });
  box.current = { width, duration };

  /** The track's left edge in window coordinates, learned at touch down. */
  const origin = useRef(0);

  const at = (pageX: number): number => {
    const { width: w, duration: d } = box.current;
    if (w <= 0 || d <= 0) return 0;
    return Math.min(Math.max((pageX - origin.current) / w, 0), 1) * d;
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        const { pageX, locationX } = event.nativeEvent;
        origin.current = pageX - locationX;
        setDragging(at(pageX));
      },
      onPanResponderMove: (event) => setDragging(at(event.nativeEvent.pageX)),
      onPanResponderRelease: (event) => {
        const seconds = at(event.nativeEvent.pageX);
        setDragging(null);
        void player.seek(seconds);
      },
      onPanResponderTerminate: () => setDragging(null),
    }),
  ).current;

  const shown = dragging ?? time;
  const fraction = duration > 0 ? Math.min(shown / duration, 1) : 0;

  return (
    <View>
      <View
        style={compact ? styles.trackCompact : styles.track}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        accessibilityRole="adjustable"
        accessibilityLabel="播放进度"
        {...responder.panHandlers}
      >
        <View style={styles.rail} pointerEvents="none">
          <View style={[styles.fill, { width: `${fraction * 100}%` }]} />
        </View>
        {/* The head. Half its width of negative margin puts its CENTRE on the
            position rather than its left edge. */}
        <View style={[styles.head, { left: `${fraction * 100}%` }]} pointerEvents="none" />
      </View>
      <View style={styles.times}>
        <Text style={compact ? styles.timeCompact : styles.time}>{clock(shown)}</Text>
        <Text style={compact ? styles.timeCompact : styles.time}>{clock(duration)}</Text>
      </View>
    </View>
  );
}

const HEAD = 10;

const styles = StyleSheet.create({
  track: { height: 28, justifyContent: 'center' },
  // Still a 28pt touch target: a 3pt bar is not something a thumb can hit.
  trackCompact: { height: 20, justifyContent: 'center' },
  rail: { height: 3, backgroundColor: C.border, borderRadius: 2 },
  fill: { height: 3, backgroundColor: C.active, borderRadius: 2 },
  head: {
    position: 'absolute',
    width: HEAD,
    height: HEAD,
    marginLeft: -HEAD / 2,
    borderRadius: HEAD / 2,
    backgroundColor: C.active,
  },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  time: { color: C.faint, fontSize: 11 },
  timeCompact: { color: C.faint, fontSize: 10 },
});
