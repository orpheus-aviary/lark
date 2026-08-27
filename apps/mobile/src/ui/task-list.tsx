// What the downloads are doing (N4d-1, §2.3).
//
// The hub's first consumer. It reads `useDownloads()` and never polls the
// engine: every visible change already comes through a callback, and a screen
// that asked on a timer would be a second source of truth that is sometimes
// behind the first.
//
// TWO GROUPS, TWO SOURCES (0.1.1 ⑦). What is RUNNING is the engine's, live.
// What has FINISHED comes from `downloads/history.ts` — a file, so it is still
// there tomorrow — and the engine's own 100-task ring is no longer drawn at
// all: it is the engine's memory rather than a record, and a download that
// failed while the phone was in a pocket used to be gone before anyone looked.
//
// A ROW NAMES ITSELF WITH `taskTitle`, which falls back to the input. A queued
// link genuinely has no name until `naming` runs, and inventing one would be
// worse than showing the URL that was pasted.

import { readNamingMode, resolveNamingMode } from '@lark/core/portable';
import type { DownloadBatchData, DownloadTaskData } from '@lark/shared';
import { KIND_LABELS, batchDone, taskLabel, taskTitle } from '@lark/shared';
import { X } from 'lucide-react-native';
import type { ReactNode } from 'react';
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
import { type DownloadRecord, canRetry, planRetry } from '../downloads/history';
import { downloadHistoryOnce } from '../downloads/history-runtime';
import { recognise, submitDownload } from '../downloads/preflight';
import { type ReplayDeps, replay, summariseReplays } from '../downloads/replay';
import { downloadListRows, failedRecords, latestBatch } from '../downloads/rows';
import { useDownloads } from '../downloads/use-downloads';
import { useDownloadHistory } from '../downloads/use-history';
import { useLibrary } from './library-context';
import { C, S } from './theme';

/**
 * 0.1.1 ③: this list is the WHOLE PAGE's scroll container, and `header` is
 * whatever the page wants above it.
 *
 * The add page used to be a fixed form with this list scrolling underneath it,
 * so a long paste pushed the 下载 button off its own screen with nothing to
 * scroll. A `ScrollView` around both is not available — nesting a
 * `VirtualizedList` inside one is exactly the thing React Native refuses — so
 * the list takes the form instead.
 *
 * 🔴 `header` IS AN ELEMENT, NEVER A FUNCTION. `ListHeaderComponent={() => …}`
 * builds a new component TYPE on every render, which unmounts and remounts the
 * header — and the header holds a `TextInput`, so every keystroke would drop
 * the keyboard.
 */
export function TaskList({ header }: { header?: ReactNode }) {
  const { boot } = useLibrary();
  const runtime = useMemo(() => downloadRuntimeOnce(boot), [boot]);
  const engine = runtime.engine;
  const { tasks, batches, foreground } = useDownloads();
  const history = useMemo(() => downloadHistoryOnce(boot), [boot]);
  const records = useDownloadHistory(boot);
  // What the last cancel or retry answered. Not a toast: this app has no toast
  // library, and the answer to "did that do anything?" belongs next to the
  // list it was about.
  const [said, setSaid] = useState<string | null>(null);
  /** True while a 重下 is talking to bilibili. One at a time; see `retryAll`. */
  const [busy, setBusy] = useState(false);

  const active = tasks.filter(isActive);
  const rows = useMemo(() => downloadListRows(tasks, records), [tasks, records]);
  const failed = useMemo(() => failedRecords(records), [records]);
  const batch = latestBatch(batches);

  // The add page's own two functions, bound once. A retry goes back through
  // the SAME recogniser somebody typing the link would meet — one parser, one
  // set of refusals (`downloads/replay.ts`).
  const replayDeps: ReplayDeps = useMemo(
    () => ({
      recognise: (text) => recognise({ client: runtime.bilibili, hasLlm: runtime.hasLlm }, text),
      submit: (item, playlistIds) =>
        submitDownload(
          {
            client: runtime.bilibili,
            hasLlm: runtime.hasLlm,
            foreground: runtime.foreground,
            engine: runtime.engine,
          },
          {
            item,
            // A keyword carries no mode at all — portable refuses one. A video
            // takes whatever 命名 is chosen NOW: the record does not carry the
            // mode it was submitted under (`downloads/history.ts` says why),
            // and today's answer is the honest reading of today's button.
            namingMode:
              item.kind === 'keyword'
                ? undefined
                : resolveNamingMode({
                    remembered: readNamingMode(boot.deviceSettings),
                    hasLlm: runtime.hasLlm(),
                  }),
            playlistIds: [...playlistIds],
          },
        ).then(() => undefined),
      redownload: (songId) => {
        runtime.engine.enqueueRedownload(songId);
      },
      lyrics: (songId) => {
        runtime.engine.enqueueLyrics(songId);
      },
    }),
    [runtime, boot],
  );

  const retryOne = async (record: DownloadRecord): Promise<void> => {
    setBusy(true);
    setSaid((await replay(replayDeps, planRetry(record))).message);
    setBusy(false);
  };

  /**
   * 全部重试 — the failed records only, one at a time.
   *
   * Serial rather than parallel: each one may cost a short-link hop, and
   * twenty of those at once is a rate-limit incident (the same reason a paste
   * is settled offline, N4h decision b).
   */
  const retryAll = async (): Promise<void> => {
    setBusy(true);
    const outcomes = [];
    for (const record of failed) outcomes.push(await replay(replayDeps, planRetry(record)));
    setSaid(summariseReplays(outcomes));
    setBusy(false);
  };

  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => row.key}
      style={styles.fill}
      // So a tap on 下载 with the keyboard up reaches 下载, while a tap on the
      // list itself still dismisses it (the settings page's rule).
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <>
          {header}
          <Warning status={foreground} />
          <BatchLine batch={batch} />
          {said !== null && <Text style={styles.said}>{said}</Text>}
        </>
      }
      renderItem={({ item }) => {
        switch (item.kind) {
          case 'head':
            return item.section === 'tasks' ? (
              <View style={styles.head}>
                <Text style={styles.title}>下载任务</Text>
                {active.length > 0 && (
                  <Pressable
                    style={styles.headButton}
                    onPress={() => setSaid(summariseCancels(cancelActive(engine, tasks)))}
                    accessibilityRole="button"
                    accessibilityLabel="全部取消"
                  >
                    <Text style={styles.headButtonLabel}>全部取消</Text>
                  </Pressable>
                )}
              </View>
            ) : (
              <View style={styles.head}>
                <Text style={styles.title}>下载记录 {item.count} 条</Text>
                {failed.length > 0 && (
                  <Pressable
                    style={[styles.headButton, busy && styles.buttonOff]}
                    onPress={() => void retryAll()}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={`全部重试 ${failed.length} 条`}
                  >
                    <Text style={styles.headButtonLabel}>全部重试 {failed.length}</Text>
                  </Pressable>
                )}
                <Pressable
                  style={styles.headButton}
                  onPress={() => history.clear()}
                  accessibilityRole="button"
                  accessibilityLabel="清空记录"
                >
                  <Text style={styles.headButtonLabel}>清空</Text>
                </Pressable>
              </View>
            );
          case 'task':
            return (
              <TaskRow
                task={item.task}
                onCancel={() => setSaid(describeCancel(cancelOne(engine, item.task)))}
              />
            );
          case 'record':
            return (
              <RecordRow
                record={item.record}
                busy={busy}
                onRetry={() => void retryOne(item.record)}
                onRemove={() => history.remove(item.record.id)}
              />
            );
          case 'empty':
            return <Text style={styles.empty}>{item.text}</Text>;
        }
      }}
    />
  );
}

/** One task the engine is still working on. */
function TaskRow({ task, onCancel }: { task: DownloadTaskData; onCancel: () => void }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={1}>
          {KIND_LABELS[task.kind] === null
            ? taskTitle(task)
            : `${KIND_LABELS[task.kind]} · ${taskTitle(task)}`}
        </Text>
        <Text style={styles.state}>{taskLabel(task)}</Text>
      </View>
      <Pressable
        style={styles.cancel}
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel={`取消 ${taskTitle(task)}`}
        hitSlop={8}
      >
        <X size={18} color={C.muted} />
      </Pressable>
    </View>
  );
}

/**
 * One finished download, and what can be done to it.
 *
 * 删除 on every row; 重下 only on the ones that did not finish (`canRetry`
 * says why). The heading's 全部重试 is narrower still — the failures only,
 * because a cancel was somebody's decision and undoing every one of them at
 * once is not what that button is for.
 */
function RecordRow({
  record,
  busy,
  onRetry,
  onRemove,
}: { record: DownloadRecord; busy: boolean; onRetry: () => void; onRemove: () => void }) {
  const name = record.title ?? recordInputLabel(record);
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={1}>
          {KIND_LABELS[record.kind] === null ? name : `${KIND_LABELS[record.kind]} · ${name}`}
        </Text>
        <Text style={styles.state}>{RECORD_LABELS[record.state]}</Text>
        {/* The failure's own words. The engine's message is the only place the
            reason survives — nothing here can improve on it, and a generic
            「下载失败」 would delete it. */}
        {record.error_message !== null && (
          <Text style={styles.error} numberOfLines={2}>
            {record.error_message}
          </Text>
        )}
      </View>
      {canRetry(record) && (
        <Pressable
          style={[styles.headButton, busy && styles.buttonOff]}
          onPress={onRetry}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`重下 ${name}`}
        >
          <Text style={styles.headButtonLabel}>重下</Text>
        </Pressable>
      )}
      <Pressable
        style={styles.cancel}
        onPress={onRemove}
        accessibilityRole="button"
        accessibilityLabel={`删除记录 ${name}`}
        hitSlop={8}
      >
        <X size={18} color={C.muted} />
      </Pressable>
    </View>
  );
}

const RECORD_LABELS: Record<DownloadRecord['state'], string> = {
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** What to call a record that never got a title: whatever was asked for. */
function recordInputLabel(record: DownloadRecord): string {
  if (record.input.type === 'url') return record.input.url;
  if (record.input.type === 'keyword') return record.input.query;
  return record.input.song_id;
}

/**
 * How far the last batch got (N4f-2, decision h).
 *
 * The desktop counts a batch on its status line, beside the task that is
 * running; a phone has no status line, so this is the nearest thing — one row
 * above the list, about the most recent submission (`latestBatch`).
 *
 * `batchDone` is `@lark/shared`'s, the same function the desktop counts with,
 * and it counts SETTLED items rather than successful ones: a folder where three
 * videos are dead still finishes at 12/12, and the three failures say so in
 * their own rows. A counter that only believed successes would sit at 9/12 with
 * nothing left that could ever move it.
 */
function BatchLine({ batch }: { batch: DownloadBatchData | null }) {
  if (batch === null) return null;
  const name = batch.target.kind === 'playlist' ? batch.target.name : '曲库';
  return (
    <View style={styles.batch}>
      <Text style={styles.batchName} numberOfLines={1}>
        批量 · {name}
      </Text>
      <Text style={styles.batchCount}>
        {batchDone(batch)}/{batch.total}
      </Text>
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
  title: { color: C.text, fontSize: 15, fontWeight: '600', flex: 1 },
  headButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: S.radius,
    backgroundColor: C.surface,
  },
  headButtonLabel: { color: C.muted, fontSize: 13 },
  buttonOff: { opacity: 0.4 },
  said: { color: C.muted, fontSize: 12, paddingHorizontal: S.pad, paddingBottom: S.gap },
  batch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.gap,
    paddingHorizontal: S.pad,
    paddingTop: S.pad,
  },
  batchName: { color: C.muted, fontSize: 13, flex: 1 },
  batchCount: { color: C.text, fontSize: 13, fontWeight: '600' },
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
