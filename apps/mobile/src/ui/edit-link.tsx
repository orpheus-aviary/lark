// 更改链接 — where a song's source comes from (N4i-2, criteria 59 · 62).
//
// The six branches are `@lark/core/portable`'s (`download/source-url.ts`),
// shared with the desktop's `PUT /songs/:id`, so this screen holds no rules of
// its own. What it holds is the shape of the conversation:
//
//   TYPE  a url (or clear it)
//   识别  ask what it is, WITHOUT writing — a title you can recognise beats a
//         key you cannot (user, 2026-08-25). On a phone this matters more than
//         on the desktop: the link arrived through a share sheet and there is
//         nothing on screen to check it against.
//   保存  store the triple, and then — only if the key actually changed on a
//         song that HAS a file — offer to fetch the audio again, because the
//         file on disk is now the audio of a different video.
//
// THE CONFLICT CASE IS NAMED, NOT NAVIGATED TO (decision h). core refuses a
// key that already belongs to another song (`SourceKeyConflictError`), and the
// desktop answers by switching library view, clearing the search and scrolling
// to that row. Here it says which song owns it and stops; a phone has one
// screen, and hijacking it to show a different song is worse than a sentence.

import { InvalidSourceError, NotFoundError, SourceKeyConflictError } from '@lark/core/portable';
import type { SongData } from '@lark/shared';
import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  ToastAndroid,
  View,
} from 'react-native';
import { downloadRuntimeOnce } from '../downloads/engine';
import { type RecognizedSource, recogniseLink, resolveLink } from '../services/source-url';
import { useKeyboardSheetInset } from './keyboard';
import { useLibrary } from './library-context';
import { C, S } from './theme';

/** What the last press had to say. `ok: false` is red, not a crash. */
interface Said {
  ok: boolean;
  text: string;
}

export function EditLink({ song, onClose }: { song: SongData; onClose: () => void }) {
  const { library, boot, changed } = useLibrary();
  const runtime = downloadRuntimeOnce(boot);
  const [url, setUrl] = useState(song.source_url ?? '');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const [preview, setPreview] = useState<RecognizedSource | null>(null);
  /** Set after a save that changed the key of a song that has a file. */
  const [offerRedownload, setOfferRedownload] = useState(false);

  const trimmed = url.trim();

  const recognise = async (): Promise<void> => {
    setBusy(true);
    setSaid(null);
    setPreview(null);
    try {
      setPreview(await recogniseLink(runtime, trimmed));
    } catch (err) {
      setSaid({ ok: false, text: reason(err) });
    }
    setBusy(false);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setSaid(null);
    try {
      const triple = await resolveLink(runtime, trimmed === '' ? null : trimmed);
      // Explicit nulls, never omission: `updateSong` inherits absent fields,
      // so leaving the identity out would keep a key for a video this song no
      // longer points at (the trap the desktop route documents at M3-11).
      library.updateSong(song.id, triple);
      changed();
      const keyChanged = triple.source_key !== song.source_key;
      setOfferRedownload(keyChanged && song.has_file === true);
      setSaid({ ok: true, text: describe(triple.source_key, keyChanged) });
      if (!keyChanged || song.has_file !== true) {
        // Nothing left to ask about: leave, the way every other write on this
        // app's sheets does.
        onClose();
      }
    } catch (err) {
      setSaid({ ok: false, text: conflictOr(err, library) });
    }
    setBusy(false);
  };

  const redownload = (): void => {
    try {
      runtime.engine.enqueueRedownload(song.id);
      ToastAndroid.show(`正在重新下载《${song.name}》`, ToastAndroid.SHORT);
    } catch (err) {
      ToastAndroid.show(reason(err), ToastAndroid.SHORT);
    }
    onClose();
  };

  const inset = useKeyboardSheetInset();
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      {/* Its own window, so the app root's room does not reach it
          (`ui/keyboard.ts`). */}
      <View style={[styles.screen, { paddingBottom: inset }]}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>更改链接</Text>
          <Text style={styles.note}>{song.name}</Text>

          <TextInput
            style={styles.input}
            value={url}
            onChangeText={(next) => {
              setUrl(next);
              setPreview(null); // a preview belongs to the url it was asked about
            }}
            placeholder="粘贴 B 站链接，留空表示清除"
            placeholderTextColor={C.faint}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            accessibilityLabel="链接"
          />

          {preview !== null && (
            <View style={styles.preview}>
              <Text style={styles.previewTitle} numberOfLines={2}>
                {preview.video_title}
              </Text>
              <Text style={styles.note}>{preview.source_key}</Text>
            </View>
          )}

          <View style={styles.buttons}>
            <Pressable
              style={[styles.button, (busy || trimmed === '') && styles.buttonOff]}
              onPress={() => void recognise()}
              disabled={busy || trimmed === ''}
              accessibilityRole="button"
              accessibilityLabel="自动识别"
            >
              {busy ? (
                <ActivityIndicator size="small" color={C.muted} />
              ) : (
                <Text style={styles.buttonLabel}>自动识别</Text>
              )}
            </Pressable>
            <Pressable
              style={[styles.button, styles.buttonPrimary, busy && styles.buttonOff]}
              onPress={() => void save()}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="保存链接"
            >
              <Text style={styles.buttonLabel}>保存</Text>
            </Pressable>
          </View>

          {said !== null && (
            <Text style={said.ok ? styles.ok : styles.failed} accessibilityLabel="链接结果">
              {said.text}
            </Text>
          )}

          {offerRedownload && (
            <View style={styles.offer}>
              <Text style={styles.note}>
                这首歌已经有文件，而它现在指向另一个视频。要现在重新下载吗？
              </Text>
              <Pressable
                style={[styles.button, styles.buttonPrimary]}
                onPress={redownload}
                accessibilityRole="button"
                accessibilityLabel="重新下载"
              >
                <Text style={styles.buttonLabel}>重新下载</Text>
              </Pressable>
            </View>
          )}

          <Pressable style={styles.button} onPress={onClose} accessibilityRole="button">
            <Text style={styles.buttonLabel}>{offerRedownload ? '以后再说' : '取消'}</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

function describe(key: string | null, changed: boolean): string {
  if (key === null) return changed ? '已保存：这首歌现在没有可下载的来源。' : '已保存。';
  return `已保存：${key}`;
}

/** core's sentence, or the shortest true thing when it has none. */
function reason(err: unknown): string {
  if (err instanceof InvalidSourceError) return err.message;
  return err instanceof Error ? err.message : '没能识别这个链接';
}

/**
 * The conflict, named. Looking the other song up may itself fail (it could
 * have been deleted between the write attempt and this line), and a failure to
 * name it must not replace the reason with a mystery.
 */
function conflictOr(err: unknown, library: { getSong: (id: string) => SongData }): string {
  if (!(err instanceof SourceKeyConflictError)) return reason(err);
  try {
    return `这个链接已经属于《${library.getSong(err.conflictingSongId).name}》`;
  } catch (lookup) {
    if (lookup instanceof NotFoundError) return '这个链接已经属于另一首歌';
    throw lookup;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  body: { padding: S.pad, gap: S.gap },
  title: { color: C.text, fontSize: 20, fontWeight: '600' },
  note: { color: C.faint, fontSize: 12, lineHeight: 18 },
  input: {
    color: C.text,
    fontSize: 14,
    backgroundColor: C.surface,
    borderRadius: S.radius,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 72,
    textAlignVertical: 'top',
  },
  preview: { backgroundColor: C.surface, borderRadius: S.radius, padding: 12, gap: 4 },
  previewTitle: { color: C.text, fontSize: 15 },
  buttons: { flexDirection: 'row', gap: S.gap },
  button: {
    flex: 1,
    backgroundColor: C.surface,
    borderRadius: S.radius,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonPrimary: { backgroundColor: C.surfaceOn },
  buttonOff: { opacity: 0.4 },
  buttonLabel: { color: C.text, fontSize: 15, fontWeight: '600' },
  offer: { gap: S.gap },
  ok: { color: C.ok, fontSize: 12, lineHeight: 18 },
  failed: { color: C.danger, fontSize: 12, lineHeight: 18 },
});
