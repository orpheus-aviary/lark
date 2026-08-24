// A pasted block of links, as rows to pick from (N4h-2, §2.2).
//
// The sibling of `list-picker.tsx` and the reason `picker.tsx` exists: the
// screen, the ticking, the naming mode and the ceiling are the same question
// once the rows are there. What is this file's own is where the rows come from
// — one hop per short link, three at a time — and where the songs land.
//
// THE TARGET IS ALREADY DECIDED (§2.3,照桌面). The desktop submits pasted
// links to the playlist the library view is on; the phone's equivalent is the
// 「存到」 chip on the add page, chosen before this screen opens. So unlike a
// favourites folder — which always creates a playlist and lets its name be
// edited — this screen only says where things are going.

import type { BatchTargetInput } from '@lark/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { downloadRuntimeOnce } from '../downloads/engine';
import { type LineRow, type ParsedLine, expandLines, lineItems } from '../downloads/multi-line';
import { submitBatch } from '../downloads/preflight';
import { useLibrary } from './library-context';
import { Picker } from './picker';
import { C } from './theme';

export function LinesPicker({
  lines,
  target,
  targetName,
  onClose,
  onSubmitted,
}: {
  /** Settled offline by `readLines`; the short links are still short. */
  lines: readonly ParsedLine[];
  target: BatchTargetInput;
  /** What that target is called, for the one line this screen adds. */
  targetName: string;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const { boot } = useLibrary();
  const runtime = useMemo(() => downloadRuntimeOnce(boot), [boot]);
  const hasLlm = useMemo(() => runtime.hasLlm(), [runtime]);

  const [rows, setRows] = useState<readonly LineRow[]>([]);
  const [loading, setLoading] = useState(true);
  /** `3/12`, while the hops are in flight. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Same shape as the list picker's walk, and the same reason for the ref: a
  // prop identity must not be able to restart a dozen network hops.
  const linesRef = useRef(lines);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    expandLines({ client: runtime.bilibili, hasLlm }, linesRef.current, {
      signal: controller.signal,
      onProgress: (done, total) => {
        if (live && total > 0) setProgress({ done, total });
      },
    })
      .then((result) => {
        if (!live) return;
        setRows(result);
        setLoading(false);
      })
      .catch(() => {
        // `expandLines` does not reject — a hop that failed becomes a row with
        // its reason on it (decision d). This exists so that an abort on the
        // way out cannot surface as an unhandled rejection.
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [runtime.bilibili, hasLlm]);

  const skipped = rows.filter((row) => row.reason !== null).length;

  return (
    <Picker
      kindLabel="多行粘贴"
      loading={loading}
      loadingText={
        progress === null ? '正在读这些行…' : `正在展开短链 ${progress.done}/${progress.total}`
      }
      loadingNote="退出这一页就会停下。"
      // Not an error: it is a count of rows that are on screen with their own
      // reasons, said once at the top so nobody has to scroll to find out.
      warning={skipped === 0 ? null : `有 ${skipped} 行不能下载，已在下面标出原因`}
      emptyText="这些行里没有可以下载的东西"
      rows={rows}
      onClose={onClose}
      header={<Text style={styles.target}>存到 · {targetName}</Text>}
      onSubmit={async (chosen, mode) => {
        await submitBatch(
          {
            client: runtime.bilibili,
            hasLlm: runtime.hasLlm,
            foreground: runtime.foreground,
            engine: runtime.engine,
          },
          { target, items: lineItems(chosen, mode) },
        );
        onSubmitted();
      }}
    />
  );
}

const styles = StyleSheet.create({
  target: { color: C.muted, fontSize: 13 },
});
