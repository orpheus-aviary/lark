// The parts of one multi-part video, as rows to pick from (0.5.1 §7.3).
//
// The third source of `picker.tsx`, after a favourites folder and a pasted
// block of lines — same screen, same ticking, same naming chip, and this file
// is only where the rows come from and where they go.
//
// 🔴 IT OPENS ON A REFUSAL, NOT ON A GUESS. A link is recognised offline, so
// nothing before the tap knows a video has parts; `submitDownload` runs
// portable's preflight, which answers `MULTI_PART_UNRESOLVED`, and THAT is
// what opens this. The desktop works the same way — one mechanism, two ends —
// and it costs nothing, because the refusal happens before a task exists.
//
// 🔴 NOTHING IS TICKED WHEN IT OPENS (§7.3-d), which is the opposite of the
// other two sources. Somebody who opened a folder came for the folder; the
// whole reason this screen exists is that a person is choosing WHICH parts,
// and a 40-part collection ticked in advance turns one stray tap into forty
// downloads.
//
// 🔴 IT CREATES A PLAYLIST, LIKE EVERY OTHER GROUP (2026-08-31 对齐). Until
// this batch it submitted into whatever 「存到」 was showing on the add page —
// no playlist, no editable name — while the desktop created one and
// `INVARIANTS.md` §3 said the two matched. A 「歌曲合集」 uploaded as forty
// parts is a playlist by any other name, and it is now the same shape here as
// a favourites folder: a name you can edit, defaulted to the video's title.
// The wire shape is `partsGroupPayload`, shared with the desktop, so there is
// no second copy left to disagree.

import { partsGroupPayload } from '@lark/core/portable';
import type { DownloadPartsData } from '@lark/shared';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';
import { downloadRuntimeOnce } from '../downloads/engine';
import { type PartRow, loadParts, partRows } from '../downloads/parts';
import { submitBatch } from '../downloads/preflight';
import { useLibrary } from './library-context';
import { Picker } from './picker';
import { C, S } from './theme';

export function PartsPicker({
  bvid,
  onClose,
  onFailed,
  onSubmitted,
}: {
  bvid: string;
  onClose: () => void;
  /** The parts could not be listed. Told to choose, with nothing to choose from. */
  onFailed: (message: string) => void;
  onSubmitted: () => void;
}) {
  const { boot } = useLibrary();
  const runtime = useMemo(() => downloadRuntimeOnce(boot), [boot]);

  const [data, setData] = useState<DownloadPartsData | null>(null);
  const [loading, setLoading] = useState(true);
  /** The playlist this will create. The video's title until somebody edits it. */
  const [name, setName] = useState('');

  // One request, and leaving the page aborts it — the same shape as the other
  // two sources' walks, minus the walk: a page list arrives in one answer.
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    loadParts(runtime.bilibili, bvid, controller.signal)
      .then((result) => {
        if (!live) return;
        setData(result);
        // Seeded HERE rather than derived from `data`, because it has to stay
        // editable afterwards: a value computed from `data` on every render
        // would put the video's title back over whatever was typed.
        setName(result.title);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setLoading(false);
        onFailed(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [runtime.bilibili, bvid, onFailed]);

  const rows: readonly PartRow[] = useMemo(() => (data === null ? [] : partRows(data)), [data]);

  return (
    <Picker
      kindLabel="分P"
      initial="none"
      loading={loading}
      loadingText="正在读这个视频的分P…"
      loadingNote="退出这一页就会停下。"
      warning={null}
      emptyText="这个视频没有可下载的分P"
      rows={rows}
      onClose={onClose}
      header={
        <>
          <Text style={styles.fieldLabel}>新建歌单</Text>
          {/* The same offer the favourites folder makes, in the same words
              (`list-picker.tsx`): the desktop edits this title in place and a
              phone has no double click, so a field you can tap into is that
              gesture in this platform's idiom. */}
          <TextInput
            style={styles.name}
            value={name}
            onChangeText={setName}
            placeholder={data?.title ?? '歌单名称'}
            placeholderTextColor={C.faint}
            accessibilityLabel="歌单名称"
          />
        </>
      }
      onSubmit={async (chosen, mode) => {
        await submitBatch(
          {
            client: runtime.bilibili,
            hasLlm: runtime.hasLlm,
            foreground: runtime.foreground,
            engine: runtime.engine,
          },
          partsGroupPayload(
            bvid,
            name,
            chosen.map((row) => row.page),
            mode,
          ),
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
