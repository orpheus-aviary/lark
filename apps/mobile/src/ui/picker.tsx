// The screen both batch sources share (N4h-2).
//
// It was `list-picker.tsx`'s whole body until a pasted block of links needed
// the same thing: a full-screen list you tick, one naming mode for the group, a
// count, a ceiling, and a submit button with the reason it is disabled next to
// it. What differs between the two sources is where the rows come from, what
// the header says, and what a submission means — so those are the props, and
// everything else lives here once.
//
// A FULL-SCREEN `Modal` (N4f decision a). The phone's equivalent of the
// desktop's dialog is the sheet, and a sheet is two thirds of the screen
// (`shell.tsx`'s `sheetHolder`) — not a size you pick two hundred rows in.
//
// THE TICKS LIVE IN ONE `Set` AT THE TOP (§1.5). A `FlatList` recycles rows;
// five thousand `useState` checkboxes would be re-created as the list scrolls,
// and 全选 would have to reach into components that are not mounted.
//
// TWO KINDS OF BAD NEWS, TWO PLACES (N4f §1.4). What the SOURCE could not
// produce is a line under the header — the list is still usable and that says
// what is missing from it. What the ENGINE refused sits above the submit
// button, where the tap that caused it was: nothing was created, nothing was
// queued. Pooling them would claim those are the same event.

import { readNamingMode, resolveNamingMode, writeNamingMode } from '@lark/core/portable';
import type { DownloadNamingMode } from '@lark/shared';
import { Check } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { downloadRuntimeOnce } from '../downloads/engine';
import { engineLogger } from '../downloads/log';
import { type PickRow, eligible, overItemLimit } from '../downloads/selection';
import { allChosen, chooseAll, chosenRows, toggleEvery, toggleOne } from '../library/selection';
import { Chip } from './chip';
import { useKeyboardSheetInset } from './keyboard';
import { useLibrary } from './library-context';
import { C, S } from './theme';

export function Picker<T extends PickRow>({
  kindLabel,
  header,
  rows,
  loading,
  loadingText,
  loadingNote,
  warning,
  emptyText,
  onClose,
  onSubmit,
  initial = 'all',
}: {
  /** 收藏夹 / 合集 / 多行粘贴 — what this screen is about. */
  kindLabel: string;
  /** The source's own controls: a playlist name, a target, nothing. */
  header?: ReactNode;
  rows: readonly T[];
  loading: boolean;
  loadingText: string;
  loadingNote?: string;
  /** What the source could not produce, in its own words. */
  warning: string | null;
  emptyText: string;
  onClose: () => void;
  /** Throws to refuse: the message lands above the button, nothing is queued. */
  onSubmit: (chosen: readonly T[], mode: DownloadNamingMode) => Promise<void>;
  /**
   * What is ticked before anybody touches it (0.5.1).
   *
   * `all` is N4f decision e and stays the default: somebody who pasted twenty
   * links or opened a folder came for the whole of it. `none` is for the parts
   * of ONE video, where the screen exists precisely because a person is
   * choosing — a 40-part collection ticked in advance turns one stray tap into
   * forty downloads.
   */
  initial?: 'all' | 'none';
}) {
  const { boot } = useLibrary();
  const runtime = useMemo(() => downloadRuntimeOnce(boot), [boot]);
  const hasLlm = useMemo(() => runtime.hasLlm(), [runtime]);

  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const [touched, setTouched] = useState(false);
  const [mode, setMode] = useState<DownloadNamingMode>(() =>
    resolveNamingMode({ remembered: readNamingMode(boot.deviceSettings), hasLlm }),
  );
  const [submitting, setSubmitting] = useState(false);
  /** Why the engine would not admit the batch. Nothing was created. */
  const [refused, setRefused] = useState<string | null>(null);

  // Everything ticked, until somebody says otherwise (N4f decision e) — unless
  // the source asked for the other opening (`initial`, 0.5.1).
  // DERIVED rather than set from an effect: the rows arrive asynchronously, and
  // an effect that seeded the set would fight every tap that came before it.
  const tickable = useMemo(() => eligible(rows), [rows]);
  const ticked = touched || initial === 'none' ? chosen : chooseAll(tickable);
  const picked = chosenRows(tickable, ticked);
  const overLimit = overItemLimit(picked.length);
  const ready = picked.length > 0 && overLimit === null && !submitting;

  const tick = (next: ReadonlySet<string>): void => {
    setTouched(true);
    setChosen(next);
  };

  const chooseMode = (next: DownloadNamingMode): void => {
    setMode(next);
    // Remembered on the choice, not on the submission: someone who changed
    // their mind and then closed the app still changed their mind.
    //
    // A device setting since N7a, so remembering it is a file write. Nothing
    // waits for it and there is no form to report to — the chip has already
    // moved, and the worst a failure costs is next launch's default.
    void writeNamingMode(boot.deviceSettings, next).catch((err: unknown) => {
      engineLogger.warn({ err: String(err) }, 'could not remember the naming mode');
    });
  };

  const submit = async (): Promise<void> => {
    if (!ready) return;
    setSubmitting(true);
    setRefused(null);
    try {
      await onSubmit(picked, mode);
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const inset = useKeyboardSheetInset();
  return (
    <Modal transparent={false} animationType="slide" visible onRequestClose={onClose}>
      {/* Its own window, so the app root's room does not reach it
          (`ui/keyboard.ts`). */}
      <View style={[styles.screen, { paddingBottom: inset }]}>
        <View style={styles.header}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="取消">
            <Text style={styles.cancel}>取消</Text>
          </Pressable>
          <Text style={styles.kind}>{kindLabel}</Text>
        </View>

        {loading ? (
          <Loading text={loadingText} note={loadingNote} />
        ) : (
          <>
            <View style={styles.form}>
              {header}

              {warning !== null && <Text style={styles.warning}>{warning}</Text>}

              <View style={styles.row}>
                <Text style={styles.count}>
                  已选 {picked.length}/{tickable.length}
                </Text>
                <Pressable
                  style={styles.toggleAll}
                  onPress={() => tick(toggleEvery(ticked, tickable))}
                  accessibilityRole="button"
                  accessibilityLabel={allChosen(ticked, tickable) ? '全不选' : '全选'}
                >
                  <Text style={styles.toggleAllLabel}>
                    {allChosen(ticked, tickable) ? '全不选' : '全选'}
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
              keyExtractor={(row) => row.key}
              style={styles.list}
              // The ticks are NOT in `data` — they are one Set above this list
              // (§1.5) — so a cell has no prop of its own that changes when it
              // is ticked. Without this, tapping a row repaints nothing.
              extraData={ticked}
              ListEmptyComponent={<Text style={styles.empty}>{emptyText}</Text>}
              renderItem={({ item: row }) => (
                <Row
                  row={row}
                  on={row.reason === null && ticked.has(row.key)}
                  onPress={() => tick(toggleOne(ticked, row.key))}
                />
              )}
            />

            <Footer
              refusals={[overLimit, refused]}
              ready={ready}
              label={submitting ? '提交中…' : `下载（${picked.length}）`}
              onPress={() => void submit()}
            />
          </>
        )}
      </View>
    </Modal>
  );
}

function Loading({ text, note }: { text: string; note?: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator size="small" color={C.muted} />
      <Text style={styles.loadingText}>{text}</Text>
      {note !== undefined && <Text style={styles.loadingNote}>{note}</Text>}
    </View>
  );
}

/**
 * The submit button and the refusals that belong ABOVE it (N4f §1.4).
 *
 * Both entries of `refusals` are admission answers — the ceiling this screen
 * computes, and whatever the engine said — and neither is about a row. What a
 * SOURCE could not fetch is a different kind of news and lives under the
 * header.
 */
function Footer({
  refusals,
  ready,
  label,
  onPress,
}: {
  refusals: readonly (string | null)[];
  ready: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <View style={styles.footer}>
      {refusals.map(
        (said) =>
          said !== null && (
            <Text key={said} style={styles.refused}>
              {said}
            </Text>
          ),
      )}
      <Pressable
        style={[styles.submit, !ready && styles.submitOff]}
        onPress={onPress}
        disabled={!ready}
        accessibilityRole="button"
        accessibilityLabel="下载"
      >
        <Text style={[styles.submitLabel, !ready && styles.submitLabelOff]}>{label}</Text>
      </Pressable>
    </View>
  );
}

/**
 * One tickable line.
 *
 * A row that CANNOT be ticked still renders, greyed, with the reason under it
 * (N4h decision d): dropping it would leave somebody who pasted six lines
 * counting five and wondering which one vanished.
 */
function Row({ row, on, onPress }: { row: PickRow; on: boolean; onPress: () => void }) {
  const blocked = row.reason !== null;
  return (
    <Pressable
      style={styles.item}
      onPress={onPress}
      disabled={blocked}
      accessibilityRole="checkbox"
      accessibilityLabel={row.label}
      accessibilityState={{ checked: on, disabled: blocked }}
    >
      <View style={[styles.box, on && styles.boxOn, blocked && styles.boxOff]}>
        {on && <Check size={14} color={C.text} />}
      </View>
      <View style={styles.itemText}>
        <Text style={[styles.itemLabel, !on && styles.itemOff]} numberOfLines={1}>
          {row.label}
        </Text>
        {/* The line as pasted, and the reason it cannot go. Both are the
            source's words — nothing here rewrites them. */}
        {row.note !== null && (
          <Text style={styles.itemNote} numberOfLines={1}>
            {row.note}
          </Text>
        )}
        {row.reason !== null && (
          <Text style={styles.itemReason} numberOfLines={2}>
            {row.reason}
          </Text>
        )}
      </View>
    </Pressable>
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
  boxOff: { opacity: 0.4 },
  itemText: { flex: 1, gap: 2 },
  itemLabel: { color: C.text, fontSize: 14 },
  itemOff: { color: C.muted },
  itemNote: { color: C.faint, fontSize: 12 },
  itemReason: { color: C.danger, fontSize: 12, lineHeight: 17 },
  empty: { color: C.faint, fontSize: 13, padding: S.pad },
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
