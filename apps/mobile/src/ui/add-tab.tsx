// 添加 — paste a link, choose how it is named, and start it (N4d-2, §2.2).
//
// THE PARSE IS OFFLINE AND THE SUBMIT IS NOT, and every decision on this screen
// follows from that. `parseSongInput` settles a bvid, a video URL and a line of
// gibberish with no packet at all, so the page can say what it sees while
// somebody is still typing; only `b23.tv` needs a hop, which is why 「正在解析」
// is a state that exists on short links and nowhere else (criterion 21).
//
// WHAT V1 CANNOT DO, IT SAYS ON THE PAGE. There is no model configured on this
// device until N4e, and three things need one: keyword search, 清洗命名, and
// picking an episode out of a multi-part video. A submission that failed for
// one of those reasons and left a red line in the task list would be a wall
// discovered afterwards; instead the keyword refusal is the preview, the 清洗
// chip is disabled with its reason on it, and the multi-part gate — the only
// one that cannot be known without asking bilibili — lands inline here rather
// than in the list below.
//
// The wording of those refusals is portable's, not this file's
// (`downloads/preflight.ts`).

import { readNamingMode, resolveNamingMode, writeNamingMode } from '@lark/core/portable';
import type { DownloadNamingMode } from '@lark/shared';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { downloadRuntimeOnce } from '../downloads/engine';
import { type Recognition, recognise, submitDownload } from '../downloads/preflight';
import { useLibrary } from './library-context';
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

export function AddTab() {
  const { boot, view, changed } = useLibrary();
  const runtime = useMemo(() => downloadRuntimeOnce(boot), [boot]);
  const hasLlm = runtime.hasLlm();

  const [text, setText] = useState('');
  const [seen, setSeen] = useState<Recognition>({ kind: 'empty' });
  const [resolving, setResolving] = useState(false);
  const [mode, setMode] = useState<DownloadNamingMode>(() =>
    resolveNamingMode({ remembered: readNamingMode(boot.db.sqlite), hasLlm }),
  );
  const [playlistId, setPlaylistId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** What the last submission said, when it did not queue anything. */
  const [failed, setFailed] = useState<string | null>(null);

  const playlists = view.playlists();
  const targetName = playlists.find((entry) => entry.id === playlistId)?.name ?? LIBRARY_ONLY;

  // The one external system this screen talks to: bilibili, through the
  // recogniser. A timer and an in-flight request both belong to the text that
  // started them, so both are torn down when it changes.
  useEffect(() => {
    if (text.trim() === '') {
      setSeen({ kind: 'empty' });
      setResolving(false);
      return;
    }
    let live = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void recognise({ client: runtime.bilibili, hasLlm: () => hasLlm }, text, {
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
  }, [text, runtime.bilibili, hasLlm]);

  const chooseMode = (next: DownloadNamingMode): void => {
    setMode(next);
    // Remembered on the choice, not on the submission: someone who changed
    // their mind and then closed the app still changed their mind.
    writeNamingMode(boot.db.sqlite, next);
  };

  const submit = async (): Promise<void> => {
    if (seen.kind !== 'video' || submitting) return;
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
          item: seen.item,
          namingMode: mode,
          playlistIds: playlistId === null ? [] : [playlistId],
        },
      );
      // Straight back to the list: the next thing anybody wants to know is
      // whether it is coming down.
      setText('');
      setSeen({ kind: 'empty' });
      // A queued task has not written a row yet, but a playlist target may have
      // been merged into an existing task — cheap, and it keeps the counts here
      // honest without waiting for the download.
      changed();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const ready = seen.kind === 'video' && !submitting;

  return (
    <View style={styles.fill}>
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

        <Preview seen={seen} resolving={resolving} />

        <View style={styles.row}>
          <Text style={styles.rowLabel}>命名</Text>
          <Chip label="原标题" on={mode === 'original'} onPress={() => chooseMode('original')} />
          <Chip
            label="清洗命名"
            on={mode === 'clean'}
            disabled={!hasLlm}
            onPress={() => chooseMode('clean')}
          />
        </View>
        {!hasLlm && <Text style={styles.hint}>清洗命名需要配置 LLM，设置页在下一批开放。</Text>}

        <View style={styles.row}>
          <Text style={styles.rowLabel}>存到</Text>
          <Chip label={targetName} on onPress={() => setPicking(true)} />
        </View>

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

      <TaskList />

      {picking && (
        <Sheet title="存到哪里" onClose={() => setPicking(false)}>
          <SheetAction
            label={LIBRARY_ONLY}
            onPress={() => {
              setPlaylistId(null);
              setPicking(false);
            }}
          />
          {playlists.map((entry) => (
            <SheetAction
              key={entry.id}
              label={entry.name}
              onPress={() => {
                setPlaylistId(entry.id);
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
function Preview({ seen, resolving }: { seen: Recognition; resolving: boolean }) {
  if (resolving) {
    return (
      <View style={styles.preview}>
        <ActivityIndicator size="small" color={C.muted} />
        <Text style={styles.previewText}>正在解析短链…</Text>
      </View>
    );
  }
  if (seen.kind === 'empty') return null;
  if (seen.kind === 'refused') {
    return (
      <View style={styles.preview}>
        <Text style={styles.refused}>{seen.message}</Text>
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

function Chip({
  label,
  on,
  disabled = false,
  onPress,
}: { label: string; on: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.chip, on && styles.chipOn, disabled && styles.chipOff]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on, disabled }}
    >
      <Text style={[styles.chipLabel, on && styles.chipLabelOn, disabled && styles.chipLabelOff]}>
        {label}
      </Text>
    </Pressable>
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
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: S.radius,
    backgroundColor: C.surface,
  },
  chipOn: { backgroundColor: C.surfaceOn },
  chipOff: { opacity: 0.4 },
  chipLabel: { color: C.muted, fontSize: 13 },
  chipLabelOn: { color: C.text },
  chipLabelOff: { color: C.faint },
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
