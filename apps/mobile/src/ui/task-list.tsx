// What the downloads are doing (N4d-1, §2.3).
//
// The hub's first consumer. It reads `useDownloads()` and never polls the
// engine: every visible change already comes through a callback, and a screen
// that asked on a timer would be a second source of truth that is sometimes
// behind the first.
//
// THE ROWS ARE THE ENGINE'S OWN RING (decision c), not a list this screen
// keeps. The engine already windows terminal tasks; a second window here would
// be a second policy, so all this does is put the active ones on top — the
// order a person reads in — and show the last 20 that finished.
//
// A ROW NAMES ITSELF WITH `taskTitle`, which falls back to the input. A queued
// link genuinely has no name until `naming` runs, and inventing one would be
// worse than showing the URL that was pasted.

import { KIND_LABELS, taskLabel, taskTitle } from '@lark/shared';
import { X } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  cancelActive,
  cancelOne,
  describeCancel,
  isActive,
  summariseCancels,
} from '../downloads/cancel';
import { downloadRuntimeOnce } from '../downloads/engine';
import type { ForegroundStatus } from '../downloads/foreground';
import { useDownloads } from '../downloads/use-downloads';
import { useLibrary } from './library-context';
import { C, S } from './theme';

/** A screen and a bit of the ring. The engine keeps more; nobody scrolls to it. */
const TERMINAL_SHOWN = 20;

export function TaskList() {
  const { boot } = useLibrary();
  const { engine } = useMemo(() => downloadRuntimeOnce(boot), [boot]);
  const { tasks, foreground } = useDownloads();
  // What the last cancel answered. Not a toast: this app has no toast library,
  // and the answer to "did that stop?" belongs next to the list it was about.
  const [said, setSaid] = useState<string | null>(null);

  const active = tasks.filter(isActive);
  const rows = [...active, ...tasks.filter((task) => !isActive(task)).slice(0, TERMINAL_SHOWN)];

  return (
    <View style={styles.fill}>
      <Warning status={foreground} />
      <View style={styles.head}>
        <Text style={styles.title}>下载任务</Text>
        {active.length > 0 && (
          <Pressable
            style={styles.cancelAll}
            onPress={() => setSaid(summariseCancels(cancelActive(engine, tasks)))}
            accessibilityRole="button"
            accessibilityLabel="全部取消"
          >
            <Text style={styles.cancelAllLabel}>全部取消</Text>
          </Pressable>
        )}
      </View>
      {said !== null && <Text style={styles.said}>{said}</Text>}
      <FlatList
        data={rows}
        keyExtractor={(task) => task.id}
        style={styles.list}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.name} numberOfLines={1}>
                {KIND_LABELS[item.kind] === null
                  ? taskTitle(item)
                  : `${KIND_LABELS[item.kind]} · ${taskTitle(item)}`}
              </Text>
              <Text style={styles.state}>{taskLabel(item)}</Text>
              {/* The failure's own words. The engine's message is the only
                  place the reason survives — nothing here can improve on it,
                  and a generic "下载失败" would delete it. */}
              {item.error_message !== null && (
                <Text style={styles.error} numberOfLines={2}>
                  {item.error_message}
                </Text>
              )}
            </View>
            {isActive(item) && (
              <Pressable
                style={styles.cancel}
                onPress={() => setSaid(describeCancel(cancelOne(engine, item)))}
                accessibilityRole="button"
                accessibilityLabel={`取消 ${taskTitle(item)}`}
                hitSlop={8}
              >
                <X size={18} color={C.muted} />
              </Pressable>
            )}
          </View>
        )}
        ListEmptyComponent={<Text style={styles.empty}>还没有下载任务</Text>}
      />
    </View>
  );
}

/**
 * The two phases a person has to be told about (N4c, decision e).
 *
 * `degraded` is a download running with no foreground service holding this
 * process up — it works right now and Android may end it the moment the app
 * leaves the screen. Saying nothing would be promising a protection that is
 * not there. `paused-by-system` is the quota being taken back after six hours;
 * stopping the service takes its notification with it, so this line is the
 * only place it is ever said.
 */
function Warning({ status }: { status: ForegroundStatus }) {
  if (status.phase === 'degraded') {
    return (
      <View style={styles.warn}>
        <Text style={styles.warnText}>没有前台服务，切走可能会中断</Text>
        {status.reason !== null && <Text style={styles.warnWhy}>{status.reason}</Text>}
      </View>
    );
  }
  if (status.phase === 'paused-by-system') {
    return (
      <View style={styles.warn}>
        <Text style={styles.warnText}>系统收回了后台下载配额</Text>
      </View>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: S.pad,
    paddingTop: S.pad,
    paddingBottom: S.gap,
  },
  title: { color: C.text, fontSize: 15, fontWeight: '600' },
  cancelAll: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: S.radius,
    backgroundColor: C.surface,
  },
  cancelAllLabel: { color: C.muted, fontSize: 13 },
  said: { color: C.muted, fontSize: 12, paddingHorizontal: S.pad, paddingBottom: S.gap },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.gap,
    paddingHorizontal: S.pad,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  rowText: { flex: 1, gap: 2 },
  name: { color: C.text, fontSize: 14 },
  state: { color: C.muted, fontSize: 12 },
  error: { color: C.danger, fontSize: 12 },
  cancel: { padding: 6 },
  empty: { color: C.faint, fontSize: 13, padding: S.pad },
  warn: {
    backgroundColor: C.surface,
    borderLeftWidth: 3,
    borderLeftColor: C.active,
    paddingHorizontal: S.pad,
    paddingVertical: 10,
    gap: 2,
  },
  warnText: { color: C.text, fontSize: 13 },
  warnWhy: { color: C.faint, fontSize: 11 },
});
