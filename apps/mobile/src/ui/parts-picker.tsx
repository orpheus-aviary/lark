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

import type { BatchTargetInput, DownloadPartsData } from '@lark/shared';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { downloadRuntimeOnce } from '../downloads/engine';
import { type PartRow, loadParts, partItems, partRows } from '../downloads/parts';
import { submitBatch } from '../downloads/preflight';
import { useLibrary } from './library-context';
import { Picker } from './picker';
import { C } from './theme';

export function PartsPicker({
  bvid,
  target,
  targetName,
  onClose,
  onFailed,
  onSubmitted,
}: {
  bvid: string;
  target: BatchTargetInput;
  /** What that target is called, for the one line this screen adds. */
  targetName: string;
  onClose: () => void;
  /** The parts could not be listed. Told to choose, with nothing to choose from. */
  onFailed: (message: string) => void;
  onSubmitted: () => void;
}) {
  const { boot } = useLibrary();
  const runtime = useMemo(() => downloadRuntimeOnce(boot), [boot]);

  const [data, setData] = useState<DownloadPartsData | null>(null);
  const [loading, setLoading] = useState(true);

  // One request, and leaving the page aborts it — the same shape as the other
  // two sources' walks, minus the walk: a page list arrives in one answer.
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    loadParts(runtime.bilibili, bvid, controller.signal)
      .then((result) => {
        if (!live) return;
        setData(result);
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
          {data !== null && (
            <Text style={styles.title} numberOfLines={2}>
              {data.title}
            </Text>
          )}
          <Text style={styles.target}>存到 · {targetName}</Text>
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
          // NO `source`: a video is not a list, and inventing a list identity
          // is a lie the download record then repeats forever (0.5.0 ④).
          { target, items: partItems(bvid, chosen, mode) },
        );
        onSubmitted();
      }}
    />
  );
}

const styles = StyleSheet.create({
  title: { color: C.text, fontSize: 15, lineHeight: 21 },
  target: { color: C.muted, fontSize: 13, marginTop: 4 },
});
