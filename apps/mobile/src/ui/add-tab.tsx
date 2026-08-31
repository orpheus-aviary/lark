// 添加 — paste a link, choose how it is named, and start it (N4d-2, §2.2).
//
// THE PARSE IS OFFLINE AND THE SUBMIT IS NOT, and every decision on this screen
// follows from that. `parseSongInput` settles a bvid, a video URL and a line of
// gibberish with no packet at all, so the page can say what it sees while
// somebody is still typing; only `b23.tv` needs a hop, which is why 「正在解析」
// is a state that exists on short links and nowhere else (criterion 21).
//
// WHAT THIS DEVICE CANNOT DO, IT SAYS ON THE PAGE. Three things need a model —
// keyword search, 清洗命名, and picking an episode out of a multi-part video —
// and until somebody fills in 设置 there is none (N4e-2 gave it a page; §0
// froze that page as its ONLY source). A submission that failed for one of
// those reasons and left a red line in the task list would be a wall
// discovered afterwards; instead the keyword refusal is the preview, the 清洗
// chip is disabled with its reason on it, and the multi-part gate — the only
// one that cannot be known without asking bilibili — lands inline here rather
// than in the list below.
//
// The wording of those refusals is portable's, not this file's
// (`downloads/preflight.ts`).

import type { BilibiliClient } from '@lark/core/portable';
import {
  MultiPartUnresolvedError,
  readNamingMode,
  resolveNamingMode,
  writeNamingMode,
} from '@lark/core/portable';
import type { BatchTargetInput, DownloadNamingMode } from '@lark/shared';
import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { downloadRuntimeOnce } from '../downloads/engine';
import { engineLogger } from '../downloads/log';
import { type LineSummary, readLines } from '../downloads/multi-line';
import {
  type KeywordItem,
  type ListItem,
  type Recognition,
  type VideoItem,
  listLabel,
  recognise,
  submitDownload,
} from '../downloads/preflight';
import { subscribeShareDraft, takeShareDraft } from '../share/draft';
import { type AddDraft, shareArrived, submitted } from './add-draft';
import { Chip } from './chip';
import { useLibrary } from './library-context';
import { LinesPicker } from './lines-picker';
import { ListPicker } from './list-picker';
import { PartsPicker } from './parts-picker';
import { Sheet, SheetAction } from './sheet';
import { TaskList } from './task-list';
import { C, S } from './theme';

/**
 * How long after the last keystroke the input is looked at (decision g).
 *
 * The parse itself is free; the hop a short link needs is not, and neither is
 * re-rendering a refusal under somebody's thumb while they are halfway through
 * pasting.
 */
const PARSE_DEBOUNCE_MS = 400;

/** What the library is called when a download is not going into a playlist. */
const LIBRARY_ONLY = '仅曲库';

/**
 * What the box holds, 400ms after the last keystroke (N4h-2).
 *
 * ONE BOX, TWO READERS, and this is the only place that decides between them.
 * Two or more non-empty lines is a paste: settled entirely offline, because a
 * hop per line per keystroke is a rate-limit incident (decision b). One line is
 * what it always was — the single-line recogniser, at most one short-link hop,
 * and 「正在解析」 while it is in flight (criterion 21).
 *
 * It owns all three pieces of state, so clearing the box clears the verdict:
 * the empty branch below runs synchronously, without waiting out the debounce.
 */
function useRecognition(
  text: string,
  client: BilibiliClient,
  hasLlm: boolean,
): { seen: Recognition; resolving: boolean; lines: LineSummary | null } {
  const [seen, setSeen] = useState<Recognition>({ kind: 'empty' });
  const [resolving, setResolving] = useState(false);
  const [lines, setLines] = useState<LineSummary | null>(null);

  // The one external system this screen talks to: bilibili, through the
  // recogniser. A timer and an in-flight request both belong to the text that
  // started them, so both are torn down when it changes.
  useEffect(() => {
    if (text.trim() === '') {
      setSeen({ kind: 'empty' });
      setLines(null);
      setResolving(false);
      return;
    }
    let live = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // THE BOUNDARY (N4h §6): two or more non-empty lines is a paste, and a
      // paste is settled offline — `readLines` parses every line and touches
      // nothing. One line is what it always was: the single-line recogniser,
      // one short-link hop, 「正在解析」 (criterion 21). Running the recogniser
      // on a block would hand `parseSongInput` a blob of text, which reads as
      // free text, which would then have `findSource` pick the FIRST link out
      // of it and quietly ignore the rest.
      const paste = readLines(text);
      if (paste.total >= 2) {
        if (!live) return;
        setLines(paste);
        setSeen({ kind: 'empty' });
        setResolving(false);
        return;
      }
      setLines(null);
      void recognise({ client, hasLlm: () => hasLlm }, text, {
        signal: controller.signal,
        // Synchronous, at the moment the hop starts — the whole point of
        // criterion 21. A result that arrives for text nobody is looking at
        // any more is dropped, but this fires before there is a result.
        onResolving: () => {
          if (live) setResolving(true);
        },
      }).then((result) => {
        if (!live) return;
        setSeen(result);
        setResolving(false);
      });
    }, PARSE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, client, hasLlm]);

  return { seen, resolving, lines };
}

export function AddTab({
  draft,
  onDraft,
}: {
  /** Lives in the shell, because this page does not (③, `add-draft.ts`). */
  draft: AddDraft;
  onDraft: Dispatch<SetStateAction<AddDraft>>;
}) {
  const { boot, view, changed } = useLibrary();
  const runtime = useMemo(() => downloadRuntimeOnce(boot), [boot]);
  // ONCE PER MOUNT, not once per render (N4e-2). Until N4e-1 this read a
  // constant and was free; it is now a SQLite query plus a Keystore round trip,
  // both synchronous on the JS thread — and this screen re-renders on every
  // keystroke, which is exactly what typing a keyword search is. Correctness is
  // untouched: decision d asks for a re-read when the tab remounts, and a memo
  // recomputes on every mount; what it drops is the 2nd…Nth read of one mount.
  const hasLlm = useMemo(() => runtime.hasLlm(), [runtime]);

  const { text, playlistId } = draft;
  const setText = (next: string): void => onDraft((prev) => ({ ...prev, text: next }));
  const { seen, resolving, lines } = useRecognition(text, runtime.bilibili, hasLlm);
  const [mode, setMode] = useState<DownloadNamingMode>(() =>
    resolveNamingMode({ remembered: readNamingMode(boot.deviceSettings), hasLlm }),
  );
  const [picking, setPicking] = useState(false);
  /** The list whose picker is open. A list is chosen from, not submitted (N4f-2). */
  const [expanding, setExpanding] = useState<ListItem | null>(null);
  /** True while the pasted lines are open in their own picker. */
  const [pickingLines, setPickingLines] = useState(false);
  /**
   * The bvid whose parts are being picked (0.5.1 §7.3).
   *
   * 🔴 SET BY A REFUSAL, NOT BY A PROBE. A link is recognised offline, so
   * nothing before the tap can know a video has parts — and asking every link
   * would put a request in front of the single-part videos that are almost all
   * of them. `submitDownload` runs portable's preflight, which answers
   * `MULTI_PART_UNRESOLVED`, and that costs nothing because it happens before
   * a task exists. The desktop opens its picker the same way.
   */
  const [pickingParts, setPickingParts] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** What the last submission said, when it did not queue anything. */
  const [failed, setFailed] = useState<string | null>(null);

  const playlists = view.playlists();
  const targetName = playlists.find((entry) => entry.id === playlistId)?.name ?? LIBRARY_ONLY;

  // A share is consumed once, by whoever reaches it first, and this page is
  // the only thing that ever does. `take` runs on mount for one that arrived
  // BEFORE this page existed — a cold start, or the shell switching tab on
  // `onNewIntent` — and then on every announcement while it is here, since
  // `setTab('添加')` is a no-op when we are already on it and would never
  // remount us.
  //
  // Since ③ the draft outlives this page, so the taking hands it UP rather
  // than into local state; that is also why it can no longer be a `useState`
  // initialiser (a parent cannot be told anything during our render).
  useEffect(() => {
    const take = (): void => {
      const shared = takeShareDraft();
      if (shared !== null) onDraft((prev) => shareArrived(prev, shared));
    };
    take();
    return subscribeShareDraft(take);
  }, [onDraft]);

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

  /** One video or one keyword: queued from here, right now. */
  const startOne = async (item: VideoItem | KeywordItem): Promise<void> => {
    setSubmitting(true);
    setFailed(null);
    try {
      await submitDownload(
        {
          client: runtime.bilibili,
          hasLlm: () => hasLlm,
          foreground: runtime.foreground,
          engine: runtime.engine,
        },
        {
          item,
          // A keyword carries no mode at all (portable refuses one), so the
          // chips above are hidden for it rather than sent and ignored.
          namingMode: item.kind === 'keyword' ? undefined : mode,
          playlistIds: playlistId === null ? [] : [playlistId],
        },
      );
      // Straight back to the list: the next thing anybody wants to know is
      // whether it is coming down. Clearing the box clears the verdict — the
      // recogniser's empty branch runs on the spot, not after the debounce.
      // 存到 stays, because adding three songs to one playlist is three of
      // these.
      onDraft(submitted);
      // A queued task has not written a row yet, but a playlist target may have
      // been merged into an existing task — cheap, and it keeps the counts here
      // honest without waiting for the download.
      changed();
    } catch (err) {
      // The multi-part refusal is a question, not a failure: it says nobody
      // named a part, and this is where somebody does.
      if (err instanceof MultiPartUnresolvedError && item.kind === 'video') {
        setPickingParts(item.bvid);
        return;
      }
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (submitting) return;
    if (lines !== null) {
      // Same shape as a list: the next question is WHICH of them, and the
      // short links are expanded when that screen mounts (decision b).
      setFailed(null);
      setPickingLines(true);
      return;
    }
    if (seen.kind === 'list') {
      // A list does not download from here: the next question is WHICH of it,
      // and the answer needs a screen (§2.2). The expansion starts when that
      // screen mounts, so this tap is the last thing that happens offline.
      setFailed(null);
      setExpanding(seen.item);
      return;
    }
    if (seen.kind === 'video' || seen.kind === 'keyword') await startOne(seen.item);
  };

  // A paste is submittable when something in it could become a download: the
  // links, plus the keyword lines IF there is a model to run them (decision
  // from N4h — a keyword line without one is greyed, not fatal).
  const pasteReady =
    lines !== null && lines.refusal === null && lines.ready + (hasLlm ? lines.keywords : 0) > 0;
  const ready =
    (pasteReady || seen.kind === 'video' || seen.kind === 'keyword' || seen.kind === 'list') &&
    !submitting;
  // Naming is a question about a title, and a keyword has none — the model
  // names the song it finds. Hiding the row beats disabling it: a disabled
  // control invites "why can't I choose", and there is nothing to choose.
  //
  // A list hides BOTH rows for a different reason: it answers them on its own
  // page, one mode for the whole group (decision c) and always a new playlist
  // (decision f). Asking here would be asking twice, with the second answer
  // silently winning.
  //
  // A paste hides the naming row for the same reason a list does — its picker
  // asks once for the whole group — but KEEPS 「存到」, because that is the
  // target the batch will use (§2.3, 照桌面).
  const naming = lines === null && seen.kind !== 'keyword' && seen.kind !== 'list';
  const targeting = seen.kind !== 'list';

  return (
    <View style={styles.fill}>
      {/* 0.1.1 ③: the form is the LIST's header, so the page has one
          scrollbar from the input box to the last finished task. An
          element, never a function — see `TaskList`. */}
      <TaskList
        header={
          <View style={styles.form}>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder="粘贴 B 站视频链接，或分享到 lark"
              placeholderTextColor={C.faint}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="链接输入框"
            />

            <Preview seen={seen} resolving={resolving} lines={lines} />

            {naming && <Naming mode={mode} hasLlm={hasLlm} onChoose={chooseMode} />}

            {targeting && (
              <View style={styles.row}>
                <Text style={styles.rowLabel}>存到</Text>
                <Chip label={targetName} on onPress={() => setPicking(true)} />
              </View>
            )}

            <Pressable
              style={[styles.submit, !ready && styles.submitOff]}
              onPress={() => void submit()}
              disabled={!ready}
              accessibilityRole="button"
              accessibilityLabel="下载"
            >
              <Text style={[styles.submitLabel, !ready && styles.submitLabelOff]}>
                {submitting ? '提交中…' : '下载'}
              </Text>
            </Pressable>
            {failed !== null && <Text style={styles.failed}>{failed}</Text>}
          </View>
        }
      />

      <Chooser
        lines={pickingLines ? lines : null}
        list={expanding}
        parts={pickingParts}
        target={
          playlistId === null ? { kind: 'all' } : { kind: 'playlist', playlist_id: playlistId }
        }
        targetName={targetName}
        onClose={() => {
          setPickingLines(false);
          setExpanding(null);
          setPickingParts(null);
        }}
        onFailed={(message) => {
          // Nothing came back, so there is nothing to choose from. The refusal
          // is portable's own sentence and it belongs where every other one on
          // this page is (§2.2).
          setExpanding(null);
          setPickingParts(null);
          setFailed(message);
        }}
        onSubmitted={() => {
          setPickingLines(false);
          setExpanding(null);
          setPickingParts(null);
          onDraft(submitted);
          // A playlist may exist now, and tasks certainly do.
          changed();
        }}
      />

      {picking && (
        <Sheet title="存到哪里" onClose={() => setPicking(false)}>
          <SheetAction
            label={LIBRARY_ONLY}
            onPress={() => {
              onDraft((prev) => ({ ...prev, playlistId: null }));
              setPicking(false);
            }}
          />
          {playlists.map((entry) => (
            <SheetAction
              key={entry.id}
              label={entry.name}
              onPress={() => {
                onDraft((prev) => ({ ...prev, playlistId: entry.id }));
                setPicking(false);
              }}
            />
          ))}
        </Sheet>
      )}
    </View>
  );
}

/**
 * What the page has made of the box, in one line.
 *
 * `resolving` is its own prop rather than a fifth `Recognition` kind because it
 * is not a recognition — it is the gap between one and the next, and the last
 * result stays on screen underneath it rather than blanking.
 */
function Preview({
  seen,
  resolving,
  lines,
}: { seen: Recognition; resolving: boolean; lines: LineSummary | null }) {
  if (lines !== null) return <PastePreview lines={lines} />;
  if (resolving) {
    return (
      <View style={styles.preview}>
        <ActivityIndicator size="small" color={C.muted} />
        <Text style={styles.previewText}>正在解析短链…</Text>
      </View>
    );
  }
  if (seen.kind === 'empty') return null;
  if (seen.kind === 'keyword') {
    return (
      <View style={styles.preview}>
        <Text style={styles.previewText}>搜索「{seen.item.query}」</Text>
        <Text style={styles.previewNote}>由模型挑选视频并命名</Text>
      </View>
    );
  }
  if (seen.kind === 'refused') {
    return (
      <View style={styles.preview}>
        <Text style={styles.refused}>{seen.message}</Text>
      </View>
    );
  }
  if (seen.kind === 'list') {
    // Named, and nothing more: what is INSIDE it costs up to two hundred
    // requests to find out, and that walk belongs to the picker (§2.2).
    return (
      <View style={styles.preview}>
        <Text style={styles.previewText}>{listLabel(seen.item)}</Text>
        <Text style={styles.previewNote}>下一步挑要下的</Text>
      </View>
    );
  }
  const notes = [
    ...(seen.extracted ? ['从这段文字里认出了链接'] : []),
    ...(seen.expandedFrom === null ? [] : ['短链已展开']),
    ...(seen.item.page === null ? [] : [`第 ${seen.item.page} P`]),
  ];
  return (
    <View style={styles.preview}>
      <Text style={styles.previewText}>{seen.item.bvid}</Text>
      {notes.length > 0 && <Text style={styles.previewNote}>{notes.join(' · ')}</Text>}
    </View>
  );
}

/**
 * How the song will be named — the one question a single link still answers on
 * this page.
 *
 * A list and a paste both hide it, because their pickers ask it once for the
 * whole group; a keyword hides it because there is no title to keep or clean.
 */
function Naming({
  mode,
  hasLlm,
  onChoose,
}: {
  mode: DownloadNamingMode;
  hasLlm: boolean;
  onChoose: (mode: DownloadNamingMode) => void;
}) {
  return (
    <>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>命名</Text>
        <Chip label="原标题" on={mode === 'original'} onPress={() => onChoose('original')} />
        <Chip
          label="清洗命名"
          on={mode === 'clean'}
          disabled={!hasLlm}
          onPress={() => onChoose('clean')}
        />
      </View>
      {!hasLlm && <Text style={styles.hint}>清洗命名需要一个模型，去「设置」填一个。</Text>}
    </>
  );
}

/**
 * The screen that opens on top of this one, if any (N4h-2).
 *
 * Three sources, one slot: a list link expands into a picker of videos, a paste
 * into a picker of lines, and — since 0.5.1 — a single link that turned out to
 * be multi-part into a picker of parts. Nothing can be in two of those states
 * at once: the box holds either one line or several, and the parts one is
 * opened by a refusal that only a single line can produce. Keeping them in one
 * place is what stops the add page from growing a second copy of "who is on
 * top".
 */
function Chooser({
  lines,
  list,
  parts,
  target,
  targetName,
  onClose,
  onFailed,
  onSubmitted,
}: {
  lines: LineSummary | null;
  list: ListItem | null;
  /** The bvid whose parts are being picked, once a refusal named one. */
  parts: string | null;
  target: BatchTargetInput;
  targetName: string;
  onClose: () => void;
  onFailed: (message: string) => void;
  onSubmitted: () => void;
}) {
  if (lines !== null) {
    return (
      <LinesPicker
        lines={lines.lines}
        target={target}
        targetName={targetName}
        onClose={onClose}
        onSubmitted={onSubmitted}
      />
    );
  }
  if (list !== null) {
    return (
      <ListPicker item={list} onClose={onClose} onFailed={onFailed} onSubmitted={onSubmitted} />
    );
  }
  if (parts !== null) {
    // NO target: a parts group creates its own playlist, the same way a
    // favourites folder does (2026-08-31 对齐). 「存到」 is about the songs this
    // page submits loose, and a group does not submit loose.
    return (
      <PartsPicker bvid={parts} onClose={onClose} onFailed={onFailed} onSubmitted={onSubmitted} />
    );
  }
  return null;
}

/**
 * What a paste came to, in counts (N4h-2).
 *
 * Counts rather than rows: the rows are the picker's job, and a preview that
 * listed twelve lines under the box would push the button off the screen. What
 * this has to answer before anybody taps 下载 is「它认出了多少」—— and, when
 * some of them need a model this device does not have, that too.
 */
function PastePreview({ lines }: { lines: LineSummary }) {
  if (lines.refusal !== null) {
    return (
      <View style={styles.preview}>
        <Text style={styles.refused}>{lines.refusal}</Text>
      </View>
    );
  }
  const notes = [
    ...(lines.keywords === 0 ? [] : [`${lines.keywords} 条按歌名搜`]),
    ...(lines.unusable === 0 ? [] : [`${lines.unusable} 行不认识`]),
    ...(lines.total === lines.lines.length ? [] : [`${lines.total - lines.lines.length} 行重复`]),
  ];
  return (
    <View style={styles.preview}>
      <Text style={styles.previewText}>
        {lines.total} 行 · 可下载 {lines.ready} 条
      </Text>
      {notes.length > 0 && <Text style={styles.previewNote}>{notes.join(' · ')}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  form: {
    padding: S.pad,
    gap: S.gap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  input: {
    color: C.text,
    fontSize: 15,
    backgroundColor: C.surface,
    borderRadius: S.radius,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 76,
    textAlignVertical: 'top',
  },
  preview: { flexDirection: 'row', alignItems: 'center', gap: S.gap, minHeight: 20 },
  previewText: { color: C.text, fontSize: 13 },
  previewNote: { color: C.faint, fontSize: 12 },
  refused: { color: C.muted, fontSize: 13, flex: 1, lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.gap },
  rowLabel: { color: C.faint, fontSize: 13, width: 32 },
  hint: { color: C.faint, fontSize: 12 },
  submit: {
    backgroundColor: C.surfaceOn,
    borderRadius: S.radius,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  submitOff: { opacity: 0.4 },
  submitLabel: { color: C.text, fontSize: 15, fontWeight: '600' },
  submitLabelOff: { color: C.faint },
  failed: { color: C.danger, fontSize: 12, lineHeight: 18 },
});
