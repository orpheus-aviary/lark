// The conflicts screen (N5e, criterion 80; decision g).
//
// A conflict here is narrow on purpose (`portable/sync/conflicts.ts`): a song
// whose remote put won while this device held a different edit. The row on
// disk ALREADY holds the remote value — the question is only whether to put
// the local one back.
//
// TWO BUTTONS AND NO DIFF (decision g). `resolveConflict` takes
// `strategy: 'local' | 'remote'` and nothing else, so a field-by-field merge
// would be a screen offering a choice the engine cannot execute. The desktop
// does not have one either.
//
// 🔴 THE CAS IS THE POINT, and it is the reason each row carries a key rather
// than just an id. Between a conflict appearing and somebody answering it, a
// THIRD device can write again — restoring the local copy over that would
// silently undo a change nobody ever saw. `conflictWinnerKey` is the token the
// engine checks; if the row moved on, the resolve is refused and the person is
// told, rather than the change being applied to whatever is there now.

import {
  type ConflictRow,
  conflictWinnerKey,
  listConflicts,
  resolveConflict,
} from '@lark/core/portable';
import type { PortableDb } from '@lark/core/portable';
import type { SongSyncPayload } from '@lark/shared';
import { useCallback, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { refreshSync } from '../sync/hub';
import { C, S } from './theme';

export interface ConflictsScreenProps {
  db: PortableDb;
  onClose: () => void;
}

export function ConflictsScreen({ db, onClose }: ConflictsScreenProps) {
  const [said, setSaid] = useState<string | null>(null);
  /**
   * Re-read after an answer. Nothing else re-renders this screen — the hub is
   * the settings tab's subscription, not this modal's.
   */
  const [, bump] = useState(0);

  // Read during render, not in an effect and not memoised. It is a synchronous
  // query over a table that holds single digits, and both alternatives are
  // worse here: an effect renders the stale list once before correcting
  // itself, and a `useMemo` keyed on a bump counter is a cache with a
  // cache-busting token, which is just this with extra steps.
  const rows: readonly ConflictRow[] = listConflicts(db.sqlite).filter(
    (row) => row.resolved_at === null,
  );

  const answer = useCallback(
    (row: ConflictRow, strategy: 'local' | 'remote') => {
      setSaid(null);
      try {
        resolveConflict(db, row.id, { strategy, expected_current: conflictWinnerKey(row) });
      } catch (err) {
        // The commonest failure is the CAS: somebody else edited the song
        // again while this screen was open. Saying so beats a silent no-op.
        setSaid(err instanceof Error ? err.message : '这条冲突没能处理');
      } finally {
        bump((n) => n + 1);
        refreshSync();
      }
    },
    [db],
  );

  return (
    <Modal transparent={false} animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.screen}>
        <View style={styles.head}>
          <Text style={styles.title}>冲突</Text>
          <Pressable onPress={onClose} accessibilityRole="button">
            <Text style={styles.link}>关闭</Text>
          </Pressable>
        </View>

        {said !== null && <Text style={styles.failed}>{said}</Text>}

        {rows.length === 0 ? (
          <Text style={styles.note}>没有待处理的冲突。</Text>
        ) : (
          <ScrollView contentContainerStyle={styles.list}>
            <Text style={styles.note}>
              这些歌在两台设备上被同时改过。曲库现在保存的是远端那份——
              「用本机的」会把这台设备当时的内容重新发出去。
            </Text>
            {rows.map((row) => (
              <ConflictCard key={row.id} row={row} onAnswer={answer} />
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function ConflictCard({
  row,
  onAnswer,
}: { row: ConflictRow; onAnswer: (row: ConflictRow, strategy: 'local' | 'remote') => void }) {
  const local = parseSong(row.local_payload);
  const remote = parseSong(row.remote_payload);

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle} numberOfLines={1}>
        {remote?.name ?? local?.name ?? row.entity_id}
      </Text>
      <Text style={styles.note}>{describeWhen(row.detected_at)}</Text>

      <View style={styles.side}>
        <Text style={styles.sideLabel}>本机</Text>
        <Text style={styles.sideValue} numberOfLines={2}>
          {describeSong(local)}
        </Text>
      </View>
      <View style={styles.side}>
        <Text style={styles.sideLabel}>远端（当前保存的）</Text>
        <Text style={styles.sideValue} numberOfLines={2}>
          {describeSong(remote)}
        </Text>
      </View>

      <View style={styles.buttons}>
        <Pressable
          style={styles.button}
          onPress={() => onAnswer(row, 'local')}
          accessibilityRole="button"
          // Disabled rather than hidden: a conflict whose local copy was never
          // recorded is a real state (the column is nullable), and a card with
          // one button silently missing reads as a bug.
          disabled={local === null}
        >
          <Text style={[styles.buttonLabel, local === null && styles.buttonLabelOff]}>
            用本机的
          </Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.buttonPrimary]}
          onPress={() => onAnswer(row, 'remote')}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>保留远端</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** `null` and `'{}'` are the same thing: a record that kept no local copy. */
function parseSong(raw: string | null): SongSyncPayload | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return Object.keys(parsed).length === 0 ? null : (parsed as SongSyncPayload);
  } catch {
    return null;
  }
}

function describeSong(song: SongSyncPayload | null): string {
  if (song === null) return '（这台设备没有保存当时的内容）';
  const artist = song.artist === '' ? '未知歌手' : song.artist;
  return `${song.name} · ${artist}`;
}

function describeWhen(atMs: number): string {
  const minutes = Math.floor((Date.now() - atMs) / 60_000);
  if (minutes < 1) return '刚刚发现';
  if (minutes < 60) return `${minutes} 分钟前发现`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前发现` : `${Math.floor(hours / 24)} 天前发现`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg, padding: S.pad, gap: S.pad },
  head: { flexDirection: 'row', alignItems: 'center', gap: S.gap },
  title: { color: C.text, fontSize: 20, fontWeight: '600', flex: 1 },
  link: { color: C.muted, fontSize: 15 },
  list: { gap: S.pad, paddingBottom: S.pad },
  note: { color: C.faint, fontSize: 12, lineHeight: 18 },
  failed: { color: C.danger, fontSize: 12, lineHeight: 18 },
  card: { backgroundColor: C.surface, borderRadius: S.radius, padding: S.pad, gap: S.gap },
  cardTitle: { color: C.text, fontSize: 16, fontWeight: '600' },
  side: { gap: 2 },
  sideLabel: { color: C.faint, fontSize: 12 },
  sideValue: { color: C.text, fontSize: 14 },
  buttons: { flexDirection: 'row', gap: S.gap, marginTop: 4 },
  button: {
    flex: 1,
    backgroundColor: C.bg,
    borderRadius: S.radius,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonPrimary: { backgroundColor: C.surfaceOn },
  buttonLabel: { color: C.text, fontSize: 15, fontWeight: '600' },
  buttonLabelOff: { color: C.faint },
});
