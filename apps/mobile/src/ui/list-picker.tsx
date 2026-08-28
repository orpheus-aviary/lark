// A favourites folder or a collection, as rows to pick from (N4f-2, §2.2).
//
// The screen is `picker.tsx`'s (N4h-2 pulled it out when a pasted block of
// links needed the same one). What is left here is what makes this source
// itself: the walk, the playlist it will create, and what a submission means.
//
// IT EXPANDS ON MOUNT, and that is the desktop's timing rather than a shortcut
// (decision b). `BatchSelectModal` fetches in an effect when it opens, and it
// only opens after somebody submitted; the add page here re-recognises on every
// debounce, so expanding at recognition would put a bilibili request behind
// every keystroke. The walk is up to two hundred sequential requests, so it has
// a state of its own and an `AbortController` that leaving the page fires.

import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';
import { downloadRuntimeOnce } from '../downloads/engine';
import { type ListItem, expandList, listLabel, submitListBatch } from '../downloads/preflight';
import { type ListVideo, listRows, pickable } from '../downloads/selection';
import { useLibrary } from './library-context';
import { Picker } from './picker';
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

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<readonly ListVideo[]>([]);
  /** What the walk could not fetch. Portable's sentence, unedited (§1.3). */
  const [warning, setWarning] = useState<string | null>(null);
  const [name, setName] = useState('');

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
        setRows(pickable(listRows(result.videos)));
        setName(result.title === '' ? listLabel(item) : result.title);
        setWarning(
          result.error === null
            ? null
            : `${result.error}（已取回 ${result.videos.length} 条，可继续选择）`,
        );
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

  return (
    <Picker
      kindLabel={listLabel(item)}
      loading={loading}
      loadingText="正在取列表…"
      loadingNote="可能要几十秒。退出这一页就会停下。"
      warning={warning}
      emptyText="这个列表里没有视频"
      rows={rows}
      onClose={onClose}
      header={
        <>
          <Text style={styles.fieldLabel}>新建歌单</Text>
          {/* Editable in place: the desktop edits this title on a double
              click, and a phone has no such gesture — nor does RN have an
              `onDoubleClick`. A field you can tap into is the same offer in
              the idiom this platform has (decision f). */}
          <TextInput
            style={styles.name}
            value={name}
            onChangeText={setName}
            placeholder={listLabel(item)}
            placeholderTextColor={C.faint}
            accessibilityLabel="歌单名称"
          />
        </>
      }
      onSubmit={async (chosen, mode) => {
        await submitListBatch(
          {
            client: runtime.bilibili,
            hasLlm: runtime.hasLlm,
            foreground: runtime.foreground,
            engine: runtime.engine,
          },
          { item, name, videos: chosen, namingMode: mode },
        );
        onSubmitted();
      }}
    />
  );
}

const styles = StyleSheet.create({
  fieldLabel: { color: C.faint, fontSize: 13 },
  name: {
    color: C.text,
    fontSize: 15,
    backgroundColor: C.surface,
    borderRadius: S.radius,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
