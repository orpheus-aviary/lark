// The four tabs (D9), and the two that are deliberately empty (N2f).
//
// Hand-rolled rather than react-navigation or expo-router: four peers and one
// detail screen is a `useState`, and a router would be a dependency, a native
// rebuild and a file-layout convention bought for a switch statement. When N3
// adds a player route that has to survive tab changes, that is the moment to
// ask whether this is still true.
//
// As of N4d-2 the 添加 tab is a real screen (`add-tab.tsx`): paste a link,
// choose how it is named, start it; as of N4e-2 设置 is a real form too
// (`settings-tab.tsx`), which is where the model that unlocks four of the add
// page's refusals is typed. Sync is the last empty thing here, and it is N5.

import { syncBadgeView } from '@lark/shared';
import { useEffect, useState } from 'react';
import { BackHandler, Dimensions, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { hasShareDraft, subscribeShareDraft } from '../share/draft';
import { useSyncNow } from '../sync/use-sync';
import { type AddDraft, EMPTY_ADD_DRAFT } from './add-draft';
import { AddTab } from './add-tab';
import { BACK, handleBack, useBack } from './back';
import { MiniBar } from './minibar';
import { PlayerScreen } from './player-screen';
import { PlaylistsTab } from './playlists-tab';
import { QueueSheet } from './queue-sheet';
import { SettingsTab } from './settings-tab';
import { SongsTab } from './songs-tab';
import { C, S } from './theme';

const TABS = ['歌曲', '歌单', '添加', '设置'] as const;
type Tab = (typeof TABS)[number];

export function Shell() {
  // 歌曲 unless somebody shared something into a cold start, in which case the
  // tab that can act on it is the one to open (N4d-3). Switching AFTER the
  // first paint would work too and would flash the wrong screen at someone who
  // just asked for this one.
  const [tab, setTab] = useState<Tab>(() => (hasShareDraft() ? '添加' : '歌曲'));
  // The sync badge (decision i). Four tabs are full and the top bar's search
  // belongs to 歌曲/歌单, so this is a dot beside 设置 and the sentence lives
  // in the sync section itself. It answers one question — is there something
  // to go and look at — and nothing else.
  //
  // Deliberately NOT on the minibar: N4g made that line a play PROMISE, and a
  // row that also carried sync state would be two meanings in one place.
  const { status, conflicts } = useSyncNow();
  const badge = syncBadgeView(status, conflicts);
  const needsAttention = badge.attention > 0 || badge.tone === 'warn' || badge.tone === 'error';
  // Which playlist is open lives HERE, not in the tab: switching tabs
  // unmounts the tab, and a detail screen that forgot where it was every time
  // you glanced at 设置 is a screen you stop using.
  const [openPlaylist, setOpenPlaylist] = useState<string | null>(null);
  // And what 添加 was in the middle of, for the same reason (③). The page
  // still owns everything DERIVED from the text — what was recognised, which
  // picker is open, whether a submission is in flight — because none of that
  // outlives the text it was derived from.
  const [addDraft, setAddDraft] = useState<AddDraft>(EMPTY_ADD_DRAFT);
  // Two overlays over the same player, and they are INDEPENDENT. One
  // `showing` state made them mutually exclusive, so opening the queue from
  // the full screen closed the full screen — the queue is a thing you consult
  // while looking at the player, not instead of it. Two booleans, and the
  // queue's Modal is rendered last so it sits on top.
  const [playerOpen, setPlayerOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  // A share arriving while the app is already alive (`onNewIntent`). Switching
  // tab IS part of consuming it: receiving a link and staying on 歌曲 reads as
  // not having received it. It deliberately does not TAKE the draft — the page
  // it is switching to has to find it there.
  useEffect(() => subscribeShareDraft(() => setTab('添加')), []);
  // 0.1.1 ④, and this is the app's ONLY `BackHandler` subscription — every
  // screen that wants the key registers with `ui/back.ts` instead, so the
  // order they are asked in is a number rather than an accident of mount
  // order. Everything else that answers back is a `Modal`, which Android
  // handles itself through `onRequestClose`.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', handleBack);
    return () => subscription.remove();
  }, []);
  // The outermost layer: back on 歌单/添加/设置 comes home to 歌曲, and back on
  // 歌曲 is not ours — answering `false` hands it to Android, which puts the
  // app in the background WITHOUT ending the process. That distinction is the
  // whole reason `BackHandler.exitApp()` is not here: it finishes the Activity
  // and leaves the JS runtime alive, so the next launch would skip `bootOnce`
  // and its caches (`docs/INVARIANTS.md` §6).
  useBack(
    tab !== '歌曲',
    () => {
      setTab('歌曲');
      return true;
    },
    BACK.tab,
  );
  return (
    <View style={styles.fill}>
      <View style={styles.fill}>
        {tab === '歌曲' && <SongsTab />}
        {tab === '歌单' && <PlaylistsTab openId={openPlaylist} onOpen={setOpenPlaylist} />}
        {tab === '添加' && <AddTab draft={addDraft} onDraft={setAddDraft} />}
        {tab === '设置' && <SettingsTab />}
      </View>
      <MiniBar
        onOpen={() => setPlayerOpen(true)}
        onQueue={() => setQueueOpen(true)}
        // Where the progress of a fetch is (N4g-3): the task list, beside every
        // other download. The mini bar promises; 添加 shows the work.
        onTasks={() => setTab('添加')}
      />
      {playerOpen && (
        <PlayerScreen onClose={() => setPlayerOpen(false)} onQueue={() => setQueueOpen(true)} />
      )}
      {queueOpen && (
        <Modal transparent animationType="fade" visible onRequestClose={() => setQueueOpen(false)}>
          <Pressable style={styles.backdrop} onPress={() => setQueueOpen(false)}>
            {/* The height lives HERE, on the tap-swallowing wrapper, and it is
                a NUMBER: a percentage resolved against a parent with no height
                of its own, and the list inside drew two rows of four. */}
            <Pressable style={styles.sheetHolder} onPress={() => undefined}>
              <QueueSheet onClose={() => setQueueOpen(false)} />
            </Pressable>
          </Pressable>
        </Modal>
      )}
      <View style={styles.tabBar}>
        {TABS.map((name) => (
          <Pressable
            key={name}
            style={styles.tab}
            onPress={() => setTab(name)}
            accessibilityRole="button"
          >
            <Text style={[styles.tabLabel, tab === name && styles.tabOn]}>{name}</Text>
            {name === '设置' && needsAttention && <View style={styles.dot} />}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: '#000000aa', justifyContent: 'flex-end', padding: S.pad },
  sheetHolder: { maxHeight: Dimensions.get('window').height * (2 / 3) },
  // Absolute so it never widens the tab and shifts the label off centre.
  dot: {
    position: 'absolute',
    top: 8,
    right: '50%',
    marginRight: -22,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: C.danger,
  },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    backgroundColor: C.surface,
    // Room for the gesture pill. Android hands out no inset here without
    // `react-native-safe-area-context`, and the labels sat under the bar
    // until this was here (MEASURED, frozen device).
    paddingBottom: 22,
  },
  tab: { flex: 1, alignItems: 'center', paddingTop: 12, paddingBottom: 6 },
  tabLabel: { color: C.faint, fontSize: 14 },
  tabOn: { color: C.text, fontWeight: '600' },
});
