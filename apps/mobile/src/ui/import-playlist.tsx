// Importing a playlist file (N6b, criteria 88–92).
//
// The desktop's dialog, with the same two phases and the same defaults
// (`ImportPlaylistDialog.tsx`): the preview reads the file and says what would
// happen, the commit reads it AGAIN and refuses if a byte changed, because the
// answers below are indexes into the array the person was looking at. So this
// screen holds a digest and a parse, never a copy of the file.
//
// A FULL SCREEN rather than a sheet, unlike almost everything else here: a
// suspect list can be long, the target list is every playlist, and a sheet
// that scrolls in two places is a sheet nobody can aim at. Same frame the
// conflicts screen uses.
//
// THE DEFAULT IS ALWAYS "IMPORT AS NEW" (R12). Same name and artist under a
// different source key is a live cut or a remix at least as often as it is a
// duplicate, and a wrong merge is not undoable. Merging is one tap; it is just
// not the tap you take by doing nothing.
//
// WHAT IT DOES NOT SAY. The desktop mentions that imported songs have no audio
// file; here that sentence would be half the screen and it is already the
// product's normal state — a song without a file plays by fetching it (N4g).
// The note says the useful half: nothing is downloaded now.

import type { ParsedImportFile } from '@lark/core/portable';
import type { ImportSuspect, PlaylistData, PlaylistImportPreviewData } from '@lark/shared';
import { useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  ToastAndroid,
  View,
} from 'react-native';
import {
  type ImportChoice,
  type ImportFileSource,
  ImportSourceChangedError,
  commitImportFile,
  loadImportFile,
} from '../library/import';
import { pickPlaylistFile } from '../services/playlist-import';
import { useKeyboardSheetInset } from './keyboard';
import { useLibrary } from './library-context';
import { C, S } from './theme';

/** Sentinel targets; every other value is a real playlist id. */
const TARGET_NEW = '__new__';
const TARGET_ALL = '__all__';

/** A file that has been read once, with what importing it would do. */
interface Loaded {
  source: ImportFileSource;
  file: ParsedImportFile;
  preview: PlaylistImportPreviewData;
}

export function ImportPlaylistScreen({ onClose }: { onClose: () => void }) {
  const { library, view, changed } = useLibrary();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [merges, setMerges] = useState<ReadonlyMap<number, string>>(new Map());
  const [open, setOpen] = useState<number | null>(null);
  const [target, setTarget] = useState<string>(TARGET_NEW);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  /** Take a parse — a fresh pick, or the one a refused commit handed back. */
  const accept = (source: ImportFileSource, file: ParsedImportFile): void => {
    setLoaded({ source, file, preview: library.previewImport(file) });
    // The answers were about the old array; keeping them would be keeping
    // indexes into a file that no longer exists.
    setMerges(new Map());
    setOpen(null);
    setName(file.playlist_name);
  };

  const pick = async (): Promise<void> => {
    setSaid(null);
    setBusy(true);
    try {
      const source = await pickPlaylistFile();
      // A cancelled picker is an answer, not a failure: say nothing.
      if (source !== null) accept(source, await loadImportFile(library, source));
    } catch (err) {
      setLoaded(null);
      setSaid(err instanceof Error ? err.message : '这个文件读不了');
    } finally {
      setBusy(false);
    }
  };

  const chosenTarget = (): ImportChoice['target'] | null => {
    if (target === TARGET_ALL) return { kind: 'library' };
    if (target !== TARGET_NEW) return { kind: 'playlist', playlistId: target };
    const trimmed = name.trim();
    return trimmed === '' ? null : { kind: 'new', name: trimmed };
  };

  const submit = async (): Promise<void> => {
    if (loaded === null) return;
    const to = chosenTarget();
    if (to === null) {
      setSaid('请填写新歌单的名称');
      return;
    }

    setSaid(null);
    setBusy(true);
    try {
      const result = await commitImportFile(library, loaded.source, loaded.file, {
        target: to,
        reuse: merges,
      });
      changed();
      ToastAndroid.show(
        `导入完成：新建 ${result.created} 首，复用 ${result.reused} 首`,
        ToastAndroid.SHORT,
      );
      onClose();
    } catch (err) {
      if (err instanceof ImportSourceChangedError) {
        // Back to a preview of what the file says NOW — it came with the
        // error, so there is no third read and no window for a second change.
        accept(loaded.source, err.current);
        setSaid(err.message);
      } else {
        setSaid(err instanceof Error ? err.message : '导入失败');
      }
    } finally {
      setBusy(false);
    }
  };

  const inset = useKeyboardSheetInset();
  return (
    <Modal transparent={false} animationType="slide" visible onRequestClose={onClose}>
      {/* Its own window, so the app root's room does not reach it
          (`ui/keyboard.ts`). */}
      <View style={[styles.screen, { paddingBottom: inset }]}>
        <View style={styles.head}>
          <Text style={styles.title}>导入歌单</Text>
          <Pressable onPress={onClose} accessibilityRole="button">
            <Text style={styles.link}>关闭</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.note}>
            读桌面导出的歌单文件。按来源标识去重：同一个 B
            站视频只会复用库里已有的那首歌。现在不会下载任何音频。
          </Text>

          <Pressable
            style={[styles.button, busy && styles.buttonOff]}
            onPress={() => void pick()}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={styles.buttonLabel}>选择文件…</Text>
          </Pressable>
          <Text style={styles.note} numberOfLines={1}>
            {loaded?.source.name ?? '尚未选择文件'}
          </Text>

          {said !== null && <Text style={styles.failed}>{said}</Text>}

          {loaded !== null && (
            <>
              <Text style={styles.summary}>
                共 {loaded.preview.total} 首：新建 {loaded.preview.new_count} 首，复用{' '}
                {loaded.preview.reuse_count} 首
              </Text>

              {loaded.preview.suspects.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>
                    疑似重复（{loaded.preview.suspects.length}）
                  </Text>
                  <Text style={styles.note}>
                    默认都导入为新条目。同名同歌手但来源不同，往往是现场版或翻唱——
                    点一行可以改成复用库里已有的那首。
                  </Text>
                  {loaded.preview.suspects.map((suspect) => (
                    <SuspectRow
                      key={suspect.index}
                      suspect={suspect}
                      chosen={merges.get(suspect.index) ?? null}
                      expanded={open === suspect.index}
                      onToggle={() => setOpen(open === suspect.index ? null : suspect.index)}
                      onChoose={(songId) => {
                        setMerges((prev) => {
                          const next = new Map(prev);
                          if (songId === null) next.delete(suspect.index);
                          else next.set(suspect.index, songId);
                          return next;
                        });
                        setOpen(null);
                      }}
                    />
                  ))}
                </View>
              )}

              <View style={styles.section}>
                <Text style={styles.sectionTitle}>导入到</Text>
                <TargetRow
                  label="新建歌单"
                  selected={target === TARGET_NEW}
                  onPress={() => setTarget(TARGET_NEW)}
                />
                {target === TARGET_NEW && (
                  <TextInput
                    style={styles.input}
                    value={name}
                    onChangeText={setName}
                    placeholder="新歌单名称"
                    placeholderTextColor={C.faint}
                    accessibilityLabel="新歌单名称"
                  />
                )}
                <TargetRow
                  label="仅加入曲库"
                  selected={target === TARGET_ALL}
                  onPress={() => setTarget(TARGET_ALL)}
                />
                {view.playlists().map((playlist: PlaylistData) => (
                  <TargetRow
                    key={playlist.id}
                    label={`${playlist.name}（${playlist.song_count} 首）`}
                    selected={target === playlist.id}
                    onPress={() => setTarget(playlist.id)}
                  />
                ))}
              </View>
            </>
          )}
        </ScrollView>

        <Pressable
          style={[
            styles.button,
            styles.buttonPrimary,
            (busy || loaded === null) && styles.buttonOff,
          ]}
          onPress={() => void submit()}
          disabled={busy || loaded === null}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>{busy ? '处理中…' : '导入'}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/**
 * One suspect, closed or open.
 *
 * Tapping the row opens the candidates rather than toggling a merge, which is
 * decision d: RN has no `Select`, and a two-state tap would hide WHICH song a
 * merge would go into whenever there is more than one candidate.
 */
function SuspectRow({
  suspect,
  chosen,
  expanded,
  onToggle,
  onChoose,
}: {
  suspect: ImportSuspect;
  chosen: string | null;
  expanded: boolean;
  onToggle: () => void;
  onChoose: (songId: string | null) => void;
}) {
  const merged = suspect.candidates.find((candidate) => candidate.id === chosen) ?? null;

  return (
    <View style={styles.suspect}>
      <Pressable style={styles.suspectHead} onPress={onToggle} accessibilityRole="button">
        <Text style={styles.suspectName} numberOfLines={1}>
          {describe(suspect.name, suspect.artist)}
        </Text>
        <Text style={merged === null ? styles.faint : styles.chosen} numberOfLines={1}>
          {merged === null ? '导入为新条目' : `复用：${describe(merged.name, merged.artist)}`}
        </Text>
      </Pressable>

      {expanded && (
        <View style={styles.candidates}>
          <Candidate label="导入为新条目" on={chosen === null} onPress={() => onChoose(null)} />
          {suspect.candidates.map((candidate) => (
            <Candidate
              key={candidate.id}
              label={`复用：${describe(candidate.name, candidate.artist)}${
                candidate.has_file ? '（有文件）' : ''
              }`}
              on={chosen === candidate.id}
              onPress={() => onChoose(candidate.id)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function Candidate({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.candidate, on && styles.candidateOn]}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text style={styles.candidateLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function TargetRow({
  label,
  selected,
  onPress,
}: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.target, selected && styles.targetOn]}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text style={styles.targetLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function describe(name: string, artist: string): string {
  return artist === '' ? name : `${name} — ${artist}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg, padding: S.pad, gap: S.gap },
  head: { flexDirection: 'row', alignItems: 'center', gap: S.gap },
  title: { color: C.text, fontSize: 20, fontWeight: '600', flex: 1 },
  link: { color: C.muted, fontSize: 15 },
  body: { gap: S.gap, paddingBottom: S.pad },
  note: { color: C.faint, fontSize: 12, lineHeight: 18 },
  failed: { color: C.danger, fontSize: 12, lineHeight: 18 },
  summary: { color: C.text, fontSize: 15, marginTop: S.gap },
  section: { gap: S.gap, marginTop: S.gap },
  sectionTitle: { color: C.text, fontSize: 16, fontWeight: '600' },
  suspect: { backgroundColor: C.surface, borderRadius: S.radius },
  suspectHead: { padding: 12, gap: 2, minHeight: 44 },
  suspectName: { color: C.text, fontSize: 15 },
  faint: { color: C.faint, fontSize: 12 },
  chosen: { color: C.pinned, fontSize: 12 },
  candidates: { paddingHorizontal: 8, paddingBottom: 8, gap: 4 },
  candidate: {
    backgroundColor: C.bg,
    borderRadius: S.radius,
    paddingHorizontal: 12,
    justifyContent: 'center',
    minHeight: 44,
  },
  candidateOn: { backgroundColor: C.surfaceOn },
  candidateLabel: { color: C.text, fontSize: 14 },
  target: {
    backgroundColor: C.surface,
    borderRadius: S.radius,
    paddingHorizontal: 12,
    justifyContent: 'center',
    minHeight: 44,
  },
  targetOn: { backgroundColor: C.surfaceOn },
  targetLabel: { color: C.text, fontSize: 15 },
  input: {
    backgroundColor: C.surface,
    borderRadius: S.radius,
    color: C.text,
    fontSize: 15,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  button: {
    backgroundColor: C.surface,
    borderRadius: S.radius,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonPrimary: { backgroundColor: C.surfaceOn },
  buttonOff: { opacity: 0.5 },
  buttonLabel: { color: C.text, fontSize: 15, fontWeight: '600' },
});
