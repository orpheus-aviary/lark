// One song, as a row (N2f; selection mode in N4i-2).
//
// Split out of `songs-tab.tsx` when that file passed 500 lines: the row is the
// piece with its own subscriptions and its own two meanings for a tap, and it
// is what the next screen that lists songs will want.
//
// A ROW'S TAP IS PLAY, and the menu is its own button — the shape every mobile
// music app has, and the one a thumb expects. Since N4g that is true of every
// row, files or not: tapping one with no file fetches the audio and plays it
// when it lands (`downloads/ensure.ts`). Since N4i-2 there is a second meaning
// — in selection mode a tap TICKS — which is why entering that mode is a LONG
// press and why the mode is visible in the row itself (§1.7).
//
// Pinned is a channel, not a prefix. The desktop paints four states through
// four things that never collide (`SongRow.tsx`); here the pin sits AFTER the
// duration, in the desktop's own blue, so a long title keeps the whole width
// and an unpinned song shows nothing at all. The amber is the OTHER token and
// belongs to the playing row — the ticked row uses the surface tone, so the
// two never have to be told apart by colour alone (decision g).

import type { SongData } from '@lark/shared';
import { Check, EllipsisVertical, Pin } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ensureController } from '../downloads/ensure-runtime';
import { player, usePlayback } from '../player';
import { queueFrom } from '../player/queue';
import { C, S } from './theme';

export function SongRow({
  song,
  songs,
  selecting,
  chosen,
  onMenu,
  onLongPress,
  onToggle,
}: {
  song: SongData;
  songs: readonly SongData[];
  /** In selection mode a tap TICKS instead of playing (§1.7). */
  selecting: boolean;
  chosen: boolean;
  onMenu: () => void;
  onLongPress: () => void;
  onToggle: () => void;
}) {
  // Two subscriptions, both primitives (see `usePlayback`): a row re-renders
  // when it becomes the current song and when that song starts or stops, and
  // for nothing else. `currentTime` deliberately does NOT reach here — it
  // changes twice a second and no row shows it.
  const isCurrent = usePlayback((state) => state.song?.id === song.id);
  const playing = usePlayback((state) => state.playing);

  const start = (): void => {
    // The queue is FROZEN here (§2.6): whatever the list holds at the moment
    // of the tap, sort and search and all. Switching tabs afterwards does not
    // change what plays next.
    const queue = queueFrom({ kind: 'all' }, songs);
    // No file yet — the tap is still a play, it just has a download in front
    // of it (N4g, decision b). The queue handed over is this list, and it is
    // only the FALLBACK: if another list is on screen when the file lands,
    // that one wins (§2.9).
    if (song.has_file === false) {
      ensureController().request(song, queue);
      return;
    }
    void (isCurrent ? player.toggle() : player.play(song, queue));
  };

  return (
    <View style={[styles.row, chosen && styles.rowChosen]}>
      <Pressable
        style={styles.rowBody}
        onPress={selecting ? onToggle : start}
        onLongPress={onLongPress}
        accessibilityRole="button"
        accessibilityLabel={selecting ? `选择 ${song.name}` : `播放 ${song.name}`}
      >
        <View style={styles.rowNameLine}>
          {/* A tick, not a checkbox: the row is the target, and a 20dp box
              beside a 44dp row is a second thing to aim at. */}
          {selecting && (
            <Check
              size={16}
              color={chosen ? C.text : C.border}
              accessibilityLabel={chosen ? '已选' : '未选'}
            />
          )}
          <Text style={[styles.rowName, isCurrent && styles.rowNamePlaying]} numberOfLines={1}>
            {isCurrent && playing ? '▶ ' : ''}
            {song.name}
          </Text>
        </View>
        <View style={styles.rowMetaLine}>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {song.artist === '' ? '未知歌手' : song.artist} · {duration(song.duration)}
            {song.has_file === false ? ' · 需要下载' : ''}
          </Text>
          {song.pinned && (
            <>
              <Text style={styles.rowMeta}> · </Text>
              <Pin size={12} color={C.pinned} fill={C.pinned} accessibilityLabel="已固定" />
            </>
          )}
        </View>
      </Pressable>
      {/* Its own target, because the row's is play. 44dp is the smallest
          thing a thumb hits reliably. */}
      <Pressable
        style={styles.rowMenu}
        onPress={onMenu}
        accessibilityRole="button"
        accessibilityLabel={`${song.name} 的菜单`}
      >
        <EllipsisVertical size={18} color={C.muted} />
      </Pressable>
    </View>
  );
}

/** `m:ss`, and `--:--` for a song nobody has measured yet. */
function duration(seconds: number): string {
  if (seconds <= 0) return '--:--';
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  // The ticked row, in the surface tone rather than a colour of its own: the
  // amber is the PLAYING row's and the two must stay tellable apart (decision g).
  rowChosen: { backgroundColor: C.surface },
  rowBody: { flex: 1, paddingVertical: 10, paddingLeft: S.pad },
  rowMenu: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  rowNameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName: { color: C.text, fontSize: 16, flexShrink: 1 },
  // The amber the desktop's dark theme uses for the playing row
  // (`--state-active`, converted in `theme.ts`). Not a colour picked here:
  // N2f put it in the theme with no user precisely so that N3 would not choose
  // a second one.
  rowNamePlaying: { color: C.active },
  rowMetaLine: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  rowMeta: { color: C.faint, fontSize: 12 },
});
