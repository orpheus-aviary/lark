// What the downloads are doing (N4d-1, §2.3).
//
// The hub's first consumer. It reads `useDownloads()` and never polls the
// engine: every visible change already comes through a callback, and a screen
// that asked on a timer would be a second source of truth that is sometimes
// behind the first.
//
// THREE GROUPS, TWO SOURCES (0.1.1 ⑦; the third group 2026-09-02). What is
// RUNNING and what is QUEUED are the engine's, live, and they are drawn apart
// because they answer different questions — the desktop has split them since
// 0.3.0 and the words here are its words. What has FINISHED comes from
// `downloads/history.ts` — a file, so it is still there tomorrow — and the
// engine's own 100-task ring is no longer drawn at all: it is the engine's
// memory rather than a record, and a download that failed while the phone was
// in a pocket used to be gone before anyone looked.
//
// Which rows land where, and what an empty group says, is `downloads/rows.ts`:
// a group that renders in the wrong place is the one bug this screen cannot
// show you.
//
// A ROW NAMES ITSELF WITH `taskTitle`, which falls back to the input. A queued
// link genuinely has no name until `naming` runs, and inventing one would be
// worse than showing the URL that was pasted.

import { type DownloadRecord, canRetry, failedRecords, planRetry } from '@lark/core/portable';
import type { DownloadBatchData, DownloadOrigin, DownloadTaskData } from '@lark/shared';
import {
  KIND_LABELS,
  batchDone,
  originCopyText,
  originLabel,
  taskLabel,
  taskTitle,
} from '@lark/shared';
import * as Clipboard from 'expo-clipboard';
import { Copy, X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import {
  cancelActive,
  cancelOne,
  describeCancel,
  isActive,
  summariseCancels,
} from '../downloads/cancel';
import { downloadRuntimeOnce } from '../downloads/engine';
import type { ForegroundStatus } from '../downloads/foreground';
import { downloadHistoryOnce } from '../downloads/history-runtime';
import { replay, summariseReplays, supersededRecord } from '../downloads/replay';
import { replayDepsOnce } from '../downloads/replay-runtime';
import { SECTION_TITLES, downloadListRows, latestBatch } from '../downloads/rows';
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
export function TaskList({ visible, header }: { visible: boolean; header?: ReactNode }) {
  const { boot } = useLibrary();
  const runtime = useMemo(() => downloadRuntimeOnce(boot), [boot]);
  const engine = runtime.engine;
  // 🔴 FROZEN WHILE THE TAB IS HIDDEN (2026-09-02). The hub emits on every
  // progress tick — twice a second per running task — and this page is now
  // mounted whether or not anybody is on it. Same shape as `useVisibleView`,
  // and for the same reason: the work is deferred to the moment somebody
  // looks, not skipped.
  const live = useDownloads();
  const [shown, setShown] = useState(live);
  if (visible && shown !== live) setShown(live);
  const { tasks, batches, foreground } = shown;
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

  // Bound once, in `downloads/replay-runtime.ts`, and shared with the
  // automatic retry: two callers building the same request out of the same
  // parts, only one of which is on a screen.
  const replayDeps = useMemo(() => replayDepsOnce(boot), [boot]);

  /**
   * 重下 one record.
   *
   * 🔴 THE SUPERSEDED ATTEMPT IS NOT A SECOND LINE IN THE RECORD (0.5.1，用户
   * 2026-08-31). A record is keyed by its task id, so a retry — which is a new
   * task — always adds a row; without this the same song accumulates one line
   * per attempt, and 全部重试 doubles the whole list at a stroke.
   *
   * The rule already existed twice and this path had neither copy: the
   * automatic retry does it in `retry-runtime.ts`, and the desktop does it in
   * `DownloadPanel`'s `runAgain`. Same timing as both — the old row goes ONLY
   * once the new task exists, so a request that failed leaves a row that can
   * be pressed again.
   */
  const retryOne = async (record: DownloadRecord): Promise<void> => {
    setBusy(true);
    const outcome = await replay(replayDeps, planRetry(record));
    if (supersededRecord(outcome)) history.remove(record.id);
    setSaid(outcome.message);
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
    for (const record of failed) {
      const outcome = await replay(replayDeps, planRetry(record));
      if (supersededRecord(outcome)) history.remove(record.id);
      outcomes.push(outcome);
    }
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
          {/* 🔴 THE TWO PAGE-WIDE BUTTONS LIVE HERE, under 下载 and above the
              groups (用户, 2026-09-02) — the desktop keeps them in the
              dialog's footer, and a phone has no footer to keep them in: the
              bottom of this screen is the tab bar and the mini bar.
              DISABLED RATHER THAN HIDDEN, also the desktop's: a button that
              comes and goes moves everything under it. 全部取消 cannot sit on
              a group heading, because it sweeps BOTH live groups. */}
          <View style={styles.actions}>
            <Pressable
              style={[styles.headButton, active.length === 0 && styles.buttonOff]}
              disabled={active.length === 0}
              onPress={() => setSaid(summariseCancels(cancelActive(engine, tasks)))}
              accessibilityRole="button"
              accessibilityLabel="全部取消"
            >
              <Text style={styles.headButtonLabel}>全部取消</Text>
            </Pressable>
            <Pressable
              style={[styles.headButton, records.length === 0 && styles.buttonOff]}
              disabled={records.length === 0}
              onPress={() => history.clear()}
              accessibilityRole="button"
              accessibilityLabel="清除记录"
            >
              <Text style={styles.headButtonLabel}>清除记录</Text>
            </Pressable>
          </View>
          {said !== null && <Text style={styles.said}>{said}</Text>}
        </>
      }
      renderItem={({ item }) => {
        switch (item.kind) {
          case 'head':
            // 全部重试 stays ON its heading, because it is about that group
            // only — the failures among the records. That is the desktop's
            // split too.
            return (
              <View style={styles.head}>
                <Text style={styles.title}>{SECTION_TITLES[item.section]}</Text>
                <Text style={styles.headCount}>{item.count}</Text>
                {item.section === 'records' && failed.length > 0 && (
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
              </View>
            );
          case 'task':
            return (
              <TaskRow
                task={item.task}
                // The heading over a queued row already says 排队中; saying it
                // again on the row is one of two lines on a narrow screen
                // spent on nothing.
                showState={item.section === 'running'}
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
function TaskRow({
  task,
  showState,
  onCancel,
}: { task: DownloadTaskData; showState: boolean; onCancel: () => void }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={1}>
          {KIND_LABELS[task.kind] === null
            ? taskTitle(task)
            : `${KIND_LABELS[task.kind]} · ${taskTitle(task)}`}
        </Text>
        {showState && <Text style={styles.state}>{taskLabel(task)}</Text>}
        <Origin origin={task.origin} />
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
        <Origin origin={record.origin} />
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

/**
 * Where a download came from, and a way to take that with you (④).
 *
 * `undefined` for a record written before 0.2.0 — the line is simply absent
 * there, which is honest: nothing knew the answer when it was written.
 *
 * ONE BUTTON, and it copies THIS video rather than the list it came out of:
 * the reason to reach for it is a song that came out wrong, and the link that
 * reproduces it is the video's. The list is named in the line beside it.
 */
function Origin({ origin }: { origin: DownloadOrigin | undefined }) {
  if (origin === undefined) return null;
  const copyable = originCopyText(origin);
  return (
    <View style={styles.origin}>
      <Text style={styles.originText} numberOfLines={1}>
        {originLabel(origin)}
      </Text>
      {copyable !== null && (
        <Pressable
          onPress={() => {
            void Clipboard.setStringAsync(copyable);
            ToastAndroid.show('来源已复制', ToastAndroid.SHORT);
          }}
          accessibilityRole="button"
          accessibilityLabel="复制来源"
          hitSlop={8}
        >
          <Copy size={14} color={C.muted} />
        </Pressable>
      )}
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
  title: { color: C.text, fontSize: 15, fontWeight: '600' },
  headCount: { color: C.faint, fontSize: 13, flex: 1 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: S.gap,
    paddingHorizontal: S.pad,
    paddingTop: S.gap,
  },
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
  origin: { flexDirection: 'row', alignItems: 'center', gap: S.gap },
  originText: { color: C.faint, fontSize: 11, flexShrink: 1 },
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
