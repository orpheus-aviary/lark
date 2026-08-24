// The list, before you download it (N4f-2, §2.2).
//
// A FULL-SCREEN `Modal` (decision a). The desktop puts this in a dialog; the
// phone's equivalent of a dialog is the sheet, and a sheet is two thirds of the
// screen (`shell.tsx`'s `sheetHolder`) — which is not a size you pick two
// hundred rows in. It is the same shape `PlayerScreen` uses, for the same
// reason: this is a place you go, not a thing you glance at.
//
// IT EXPANDS ON MOUNT, and that is the desktop's timing rather than a shortcut
// (decision b). `BatchSelectModal` fetches in an effect when it opens, and it
// only opens after somebody submitted; the add page here re-recognises on every
// debounce, so expanding at recognition would put a bilibili request behind
// every keystroke. The walk is up to two hundred sequential requests, so it has
// a state of its own and an `AbortController` that leaving the page fires.
//
// THE TICKS LIVE IN ONE `Set` AT THE TOP (§1.5, `downloads/selection.ts`). A
// `FlatList` recycles rows; five thousand `useState` checkboxes would be
// re-created as the list scrolls, and 全选 would have to reach into components
// that are not mounted.
//
// TWO KINDS OF BAD NEWS, TWO PLACES (§1.4). What `fetchList` could not fetch is
// a line under the title — the list is still usable and this says what is
// missing from it. What the ENGINE refused sits above the submit button, where
// the tap that caused it was: nothing was created, nothing was queued. A screen
// that pooled them into one notice would be claiming those are the same event.

import { readNamingMode, resolveNamingMode, writeNamingMode } from '@lark/core/portable';
import type { DownloadNamingMode } from '@lark/shared';
import { Check } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { downloadRuntimeOnce } from '../downloads/engine';
import { type ListItem, expandList, listLabel, submitListBatch } from '../downloads/preflight';
import {
  type ListVideo,
  allChosen,
  chooseAll,
  chosenRows,
  listRows,
  overItemLimit,
  pickable,
  toggleEvery,
  toggleOne,
} from '../downloads/selection';
import { Chip } from './chip';
import { useLibrary } from './library-context';
import { C, S } from './theme';

export function ListPicker({
  item,
  onClose,
  onFailed,
  onSubmitted,
}: {
  item: ListItem;
  /** 取消, or the back gesture. Nothing was submitted. */
  onClose: () => void;
  /** Nothing came back at all — the page closes and the add screen says why. */
  onFailed: (message: string) => void;
  /** The batch was admitted: playlist created, tasks queued. */
  onSubmitted: () => void;
}) {
  const { boot } = useLibrary();
  const runtime = useMemo(() => downloadRuntimeOnce(boot), [boot]);
  const hasLlm = useMemo(() => runtime.hasLlm(), [runtime]);

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<readonly ListVideo[]>([]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  /** What the walk could not fetch. Portable's sentence, unedited (§1.3). */
  const [warning, setWarning] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<DownloadNamingMode>(() =>
    resolveNamingMode({ remembered: readNamingMode(boot.db.sqlite), hasLlm }),
  );
  const [submitting, setSubmitting] = useState(false);
  /** Why the engine would not admit the batch. Nothing was created. */
  const [refused, setRefused] = useState<string | null>(null);

  // THE CALLBACK IS READ THROUGH A REF, and that is not ceremony: the effect
  // below is a walk of up to two hundred requests, and a prop it depended on
  // would re-run it every time the ADD PAGE re-rendered — which it does on
  // every keystroke in the box behind this modal.
  const failedRef = useRef(onFailed);
  useEffect(() => {
    failedRef.current = onFailed;
  });

  // The one external system this screen talks to. `live` guards every setState
  // because the walk can outlive the page by a couple of hundred requests.
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    expandList({ client: runtime.bilibili }, item, { signal: controller.signal })
      .then((result) => {
        if (!live) return;
        // Keyed by bvid on the way in, so the ticking model — which is shared
        // with the pasted-lines source since N4h — has an identity to work with.
        const videos = pickable(listRows(result.videos));
        setRows(videos);
        setChosen(chooseAll(videos));
        setName(result.title === '' ? listLabel(item) : result.title);
        setWarning(result.error);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!live) return;
        // Nothing came back: that is a refusal about the link, not a list with
        // a warning on it, so this page has nothing left to show.
        failedRef.current(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [item, runtime.bilibili]);

  const chooseMode = (next: DownloadNamingMode): void => {
    setMode(next);
    writeNamingMode(boot.db.sqlite, next);
  };

  const picked = chosenRows(rows, chosen);
  const overLimit = overItemLimit(picked.length);
  const ready = picked.length > 0 && overLimit === null && !submitting;

  const submit = async (): Promise<void> => {
    if (!ready) return;
    setSubmitting(true);
    setRefused(null);
    try {
      await submitListBatch(
        {
          client: runtime.bilibili,
          hasLlm: () => hasLlm,
          foreground: runtime.foreground,
          engine: runtime.engine,
        },
        { name, videos: picked, namingMode: mode },
      );
      onSubmitted();
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal transparent={false} animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="取消">
            <Text style={styles.cancel}>取消</Text>
          </Pressable>
          <Text style={styles.kind}>{listLabel(item)}</Text>
        </View>

        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator size="small" color={C.muted} />
            <Text style={styles.loadingText}>正在取列表…</Text>
            <Text style={styles.loadingNote}>可能要几十秒。退出这一页就会停下。</Text>
          </View>
        ) : (
          <>
            <View style={styles.form}>
              <Text style={styles.fieldLabel}>新建歌单</Text>
              {/* Editable in place: the desktop edits this title on a double
                  click, and a phone has no such gesture — nor does RN have an
                  `onDoubleClick`. A field you can tap into is the same offer
                  in the idiom this platform has (decision f). */}
              <TextInput
                style={styles.name}
                value={name}
                onChangeText={setName}
                placeholder={listLabel(item)}
                placeholderTextColor={C.faint}
                accessibilityLabel="歌单名称"
              />

              {warning !== null && (
                <Text style={styles.warning}>
                  {warning}（已取回 {rows.length} 条，可继续选择）
                </Text>
              )}

              <View style={styles.row}>
                <Text style={styles.count}>
                  已选 {picked.length}/{rows.length}
                </Text>
                <Pressable
                  style={styles.toggleAll}
                  onPress={() => setChosen(toggleEvery(chosen, rows))}
                  accessibilityRole="button"
                  accessibilityLabel={allChosen(chosen, rows) ? '全不选' : '全选'}
                >
                  <Text style={styles.toggleAllLabel}>
                    {allChosen(chosen, rows) ? '全不选' : '全选'}
                  </Text>
                </Pressable>
              </View>

              <View style={styles.row}>
                <Text style={styles.fieldLabel}>命名</Text>
                <Chip
                  label="原标题"
                  on={mode === 'original'}
                  onPress={() => chooseMode('original')}
                />
                <Chip
                  label="清洗命名"
                  on={mode === 'clean'}
                  disabled={!hasLlm}
                  onPress={() => chooseMode('clean')}
                />
              </View>
              {!hasLlm && <Text style={styles.hint}>清洗命名需要一个模型，去「设置」填一个。</Text>}
            </View>

            <FlatList
              data={rows}
              keyExtractor={(video) => video.key}
              style={styles.list}
              // The ticks are NOT in `data` — they are one Set above this list
              // (§1.5) — so a cell has no prop of its own that changes when it
              // is ticked. Without this, tapping a row repaints nothing.
              extraData={chosen}
              ListEmptyComponent={<Text style={styles.empty}>这个列表里没有视频</Text>}
              renderItem={({ item: video }) => {
                const on = chosen.has(video.key);
                return (
                  <Pressable
                    style={styles.item}
                    onPress={() => setChosen(toggleOne(chosen, video.key))}
                    accessibilityRole="checkbox"
                    accessibilityLabel={video.title}
                    accessibilityState={{ checked: on }}
                  >
                    <View style={[styles.box, on && styles.boxOn]}>
                      {on && <Check size={14} color={C.text} />}
                    </View>
                    <Text style={[styles.itemLabel, !on && styles.itemOff]} numberOfLines={1}>
                      {video.title}
                    </Text>
                  </Pressable>
                );
              }}
            />

            <View style={styles.footer}>
              {overLimit !== null && <Text style={styles.refused}>{overLimit}</Text>}
              {refused !== null && <Text style={styles.refused}>{refused}</Text>}
              <Pressable
                style={[styles.submit, !ready && styles.submitOff]}
                onPress={() => void submit()}
                disabled={!ready}
                accessibilityRole="button"
                accessibilityLabel="下载"
              >
                <Text style={[styles.submitLabel, !ready && styles.submitLabelOff]}>
                  {submitting ? '提交中…' : `下载（${picked.length}）`}
                </Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // 24 like `player-screen.tsx`: measured against the status bar on the
  // frozen device, and a second number here would be a second answer.
  screen: { flex: 1, backgroundColor: C.bg, paddingTop: 24 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.gap,
    paddingHorizontal: S.pad,
    paddingBottom: S.gap,
  },
  cancel: { color: C.muted, fontSize: 15 },
  kind: { color: C.text, fontSize: 15, fontWeight: '600' },
  loading: { padding: S.pad, gap: S.gap, alignItems: 'center' },
  loadingText: { color: C.text, fontSize: 14 },
  loadingNote: { color: C.faint, fontSize: 12 },
  form: {
    paddingHorizontal: S.pad,
    paddingBottom: S.gap,
    gap: S.gap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  fieldLabel: { color: C.faint, fontSize: 13 },
  name: {
    color: C.text,
    fontSize: 15,
    backgroundColor: C.surface,
    borderRadius: S.radius,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  warning: { color: C.active, fontSize: 12, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.gap },
  count: { color: C.muted, fontSize: 13, flex: 1 },
  toggleAll: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: S.radius,
    backgroundColor: C.surface,
  },
  toggleAllLabel: { color: C.muted, fontSize: 13 },
  hint: { color: C.faint, fontSize: 12 },
  list: { flex: 1 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.gap,
    paddingHorizontal: S.pad,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  box: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: C.surfaceOn, borderColor: C.surfaceOn },
  itemLabel: { color: C.text, fontSize: 14, flex: 1 },
  empty: { color: C.faint, fontSize: 13, padding: S.pad },
  itemOff: { color: C.muted },
  footer: {
    padding: S.pad,
    gap: S.gap,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  refused: { color: C.danger, fontSize: 12, lineHeight: 18 },
  submit: {
    backgroundColor: C.surfaceOn,
    borderRadius: S.radius,
    paddingVertical: 12,
    alignItems: 'center',
  },
  submitOff: { opacity: 0.4 },
  submitLabel: { color: C.text, fontSize: 15, fontWeight: '600' },
  submitLabelOff: { color: C.faint },
});
