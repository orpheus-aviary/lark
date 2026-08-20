// The four tabs (D9), and the two that are deliberately empty (N2f).
//
// Hand-rolled rather than react-navigation or expo-router: four peers and one
// detail screen is a `useState`, and a router would be a dependency, a native
// rebuild and a file-layout convention bought for a switch statement. When N3
// adds a player route that has to survive tab changes, that is the moment to
// ask whether this is still true.
//
// ONE HARD BOUNDARY THIS SCREEN STILL HAS TO BE HONEST ABOUT: nothing here
// downloads. A row plays as of N3c, but there is no download link until N4, so
// the 添加 tab says so in as many words (decision e) instead of showing half a
// paste box that would do nothing.

import { LATEST_KNOWN_VERSION } from '@lark/core/portable';
import type { NowPlayingMode } from '@lark/shared';
import { LOCAL_API_VERSION } from '@lark/shared/api-paths';
import { Directory } from 'expo-file-system';
import { useState } from 'react';
import {
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { nowPlaying, usePlayback } from '../player';
import { nestDirectory } from '../ports/paths';
import { useLibrary } from './library-context';
import { MiniBar } from './minibar';
import { PlayerScreen } from './player-screen';
import { PlaylistsTab } from './playlists-tab';
import { QueueSheet } from './queue-sheet';
import { SongsTab } from './songs-tab';
import { C, S } from './theme';

const TABS = ['歌曲', '歌单', '添加', '设置'] as const;
type Tab = (typeof TABS)[number];

export function Shell() {
  const [tab, setTab] = useState<Tab>('歌曲');
  // Which playlist is open lives HERE, not in the tab: switching tabs
  // unmounts the tab, and a detail screen that forgot where it was every time
  // you glanced at 设置 is a screen you stop using.
  const [openPlaylist, setOpenPlaylist] = useState<string | null>(null);
  // Two overlays over the same player, and they are INDEPENDENT. One
  // `showing` state made them mutually exclusive, so opening the queue from
  // the full screen closed the full screen — the queue is a thing you consult
  // while looking at the player, not instead of it. Two booleans, and the
  // queue's Modal is rendered last so it sits on top.
  const [playerOpen, setPlayerOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  return (
    <View style={styles.fill}>
      <View style={styles.fill}>
        {tab === '歌曲' && <SongsTab />}
        {tab === '歌单' && <PlaylistsTab openId={openPlaylist} onOpen={setOpenPlaylist} />}
        {tab === '添加' && <AddTab />}
        {tab === '设置' && <SettingsTab />}
      </View>
      <MiniBar onOpen={() => setPlayerOpen(true)} onQueue={() => setQueueOpen(true)} />
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
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function AddTab() {
  return (
    <View style={styles.centre}>
      <Text style={styles.headline}>还不能添加歌曲</Text>
      <Text style={styles.note}>下载链路在 N4 开放。在那之前，曲库里的歌来自桌面版。</Text>
    </View>
  );
}

/**
 * One setting, and the rest diagnostics.
 *
 * The setting is N3d's: Bluetooth lyrics. Everything else a switch could
 * control still belongs to a batch that has not happened — downloads to N4,
 * sync to N5 — and a screen of switches that changed nothing would be worse
 * than a screen that says so. The diagnostics are what a person debugging this
 * build would otherwise have to ask a developer for.
 */
function SettingsTab() {
  const { boot, view } = useLibrary();
  // `limit: 0` fetches no rows and still reports the count.
  const total = view.songs({ limit: 0 }).total;
  return (
    <ScrollView contentContainerStyle={styles.settings}>
      <BluetoothLyrics />
      <NowPlayingCount />
      <Field label="曲库" value={`${total} 首`} />
      {/*
        On DISK, not in the database, and that is the point: deleting a song
        queues the removal of its directory and drains the journal, so a count
        that did not fall is a file half of a delete that never happened
        (criterion 15). Nothing outside the app can see `songs/` — it is
        app-private — so this is where it becomes observable.
      */}
      <Field label="曲库目录" value={`${songDirectories()} 个`} />
      <Field label="schema" value={`v${LATEST_KNOWN_VERSION}`} />
      <Field label="protocol" value={`v${LOCAL_API_VERSION}`} />
      <Field label="启动判定" value={`${boot.decision.action} · ${boot.decision.reason}`} />
      <Field label="install_id" value={boot.installId} />
      <Field label="device_uuid" value={boot.deviceUuid} />
      <Field
        label="启动时执行的文件操作"
        value={`${boot.drained.executed} 条 · ${boot.drained.failed} 失败 · ${boot.drained.skipped} 跳过`}
      />
      <Text style={styles.note}>下载在 N4、同步在 N5 开放。</Text>
    </ScrollView>
  );
}

/**
 * The Bluetooth lyrics switch (N3d, criterion 16).
 *
 * Off by default and stored per install (`local_metadata.now_playing_mode`),
 * because a phone that lives in a car and a phone that never sees one want
 * different answers. The bridge does the writing — this reads back what it
 * stored rather than assuming the tap won, since a value the library refuses
 * reads as the default.
 */
function BluetoothLyrics() {
  const [mode, setMode] = useState<NowPlayingMode>(() => nowPlaying.mode());
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchText}>
        <Text style={styles.fieldValue}>蓝牙歌词</Text>
        <Text style={styles.note}>
          把当前这句歌词写进「正在播放」的标题，车机和耳机屏上就能看见。关掉是歌名。
        </Text>
      </View>
      <Switch
        value={mode === 'lyrics'}
        onValueChange={(on) => {
          nowPlaying.setMode(on ? 'lyrics' : 'title');
          setMode(nowPlaying.mode());
        }}
        accessibilityLabel="蓝牙歌词"
      />
    </View>
  );
}

/**
 * How many times we have handed the system a new title for this song, and how
 * close together two of them ever came (criterion 17).
 *
 * Its own component ON PURPOSE: it subscribes to the playback tick so the
 * number is live, and the tab around it must not — `songDirectories()` lists a
 * directory on disk, and doing that twice a second would be a diagnostics
 * screen that costs more than what it diagnoses.
 */
function NowPlayingCount() {
  const time = usePlayback((state) => state.currentTime);
  const { published, minGapMs } = nowPlaying.stats();
  return (
    <Field
      label="蓝牙歌词发送（本首）"
      value={`${published} 次 · 最短间隔 ${minGapMs ?? '—'} ms · 播放到 ${time.toFixed(1)}s`}
    />
  );
}

function songDirectories(): number {
  const songs = new Directory(nestDirectory(), 'songs');
  return songs.exists ? songs.list().filter((entry) => entry instanceof Directory).length : 0;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: S.pad * 2,
    gap: S.gap,
  },
  headline: { color: C.text, fontSize: 18 },
  note: { color: C.faint, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  settings: { padding: S.pad, gap: S.pad },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: S.pad },
  switchText: { flex: 1, gap: 2 },
  field: { gap: 2 },
  fieldLabel: { color: C.faint, fontSize: 12 },
  fieldValue: { color: C.text, fontSize: 14 },
  backdrop: { flex: 1, backgroundColor: '#000000aa', justifyContent: 'flex-end', padding: S.pad },
  sheetHolder: { maxHeight: Dimensions.get('window').height * (2 / 3) },
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
