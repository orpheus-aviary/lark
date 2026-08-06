// The library table: column layout, Excel-style resizing (D4), client-side
// ordering (D5) and the one delete confirmation shared by every row (D9).

import type { SongData } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { sortSongs } from '../lib/song-sort.js';
import { useLibrary } from '../stores/library.js';
import { useViewPrefs } from '../stores/view-prefs.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { SongRow } from './SongRow.js';

type ColumnKey = 'index' | 'name' | 'artist' | 'duration' | 'fileSize' | 'createdAt' | 'actions';

const COLUMN_HEADERS: Record<ColumnKey, string> = {
  index: '#',
  name: '歌曲名称',
  artist: '歌手',
  duration: '时长',
  fileSize: '大小',
  createdAt: '创建时间',
  actions: '',
};

/** Fallback widths for when the container is too narrow to share evenly. */
const CONTENT_WIDTHS: Record<ColumnKey, number> = {
  index: 48,
  name: 120,
  artist: 100,
  duration: 64,
  fileSize: 80,
  createdAt: 160,
  actions: 96,
};

const MIN_COLUMN_WIDTH = 60;
/** Used until the ResizeObserver reports; keeps the first paint sane. */
const ASSUMED_CONTAINER_WIDTH = 800;

interface SongListProps {
  /** A song without a file downloads first and plays when it lands (M5-9). */
  onPlay: (song: SongData) => void;
  currentSongId: string | null;
}

export function SongList({ onPlay, currentSongId }: SongListProps): React.JSX.Element {
  const songs = useLibrary((s) => s.songs);
  const loading = useLibrary((s) => s.loading);
  const error = useLibrary((s) => s.error);
  const search = useLibrary((s) => s.search);
  const playlistId = useLibrary((s) => s.playlistId);
  const selectedSongId = useLibrary((s) => s.selectedSongId);
  const deleteSong = useLibrary((s) => s.deleteSong);
  const columns = useViewPrefs((s) => s.columns);
  const storedWidths = useViewPrefs((s) => s.widths);
  const setWidth = useViewPrefs((s) => s.setWidth);
  const sort = useViewPrefs((s) => s.sort);

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const dragRef = useRef<{ column: ColumnKey; startX: number; startWidth: number } | null>(null);
  const [dragWidth, setDragWidth] = useState<{ column: ColumnKey; width: number } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SongData | null>(null);

  const visible = useMemo<ColumnKey[]>(
    () => [
      'index',
      'name',
      'artist',
      ...(columns.duration ? (['duration'] as const) : []),
      ...(columns.fileSize ? (['fileSize'] as const) : []),
      ...(columns.createdAt ? (['createdAt'] as const) : []),
      'actions',
    ],
    [columns],
  );

  // Column layout depends on how much room the table actually has, which only
  // the DOM knows — the one legitimate external-system sync here.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    setContainerWidth(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setContainerWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * Finder-style widths: dragging a divider changes ONLY the column to its
   * left, and everything to the right keeps its width and simply shifts.
   *
   * That rules out the obvious "share the leftover space" layout, where every
   * untouched column is `(container - dragged) / n` and therefore shrinks
   * whenever a neighbour grows. So a column's default depends on the
   * CONTAINER alone, never on what other columns are set to, and the trailing
   * actions column is the one that absorbs the difference — until it hits its
   * minimum, at which point the table simply gets wider than the viewport and
   * scrolls.
   */
  const widths = useMemo(() => {
    const available = containerWidth > 0 ? containerWidth : ASSUMED_CONTAINER_WIDTH;
    const sized = visible.filter((column) => column !== 'actions');
    const shareable = sized.filter((column) => column !== 'index');
    const share = Math.floor(
      (available - CONTENT_WIDTHS.index - CONTENT_WIDTHS.actions) / Math.max(shareable.length, 1),
    );

    const result = {} as Record<ColumnKey, number>;
    let used = 0;
    for (const column of sized) {
      const width =
        column === 'index'
          ? CONTENT_WIDTHS.index
          : // A column the user dragged keeps that width, including across a
            // visibility toggle (D4).
            (storedWidths[column] ?? (share >= MIN_COLUMN_WIDTH ? share : CONTENT_WIDTHS[column]));
      result[column] = width;
      used += width;
    }
    result.actions = Math.max(CONTENT_WIDTHS.actions, available - used);
    return result;
  }, [visible, storedWidths, containerWidth]);

  /** While a drag is live the filler takes the delta, so nothing else moves. */
  const liveDelta = dragWidth === null ? 0 : dragWidth.width - widths[dragWidth.column];
  const widthOf = (column: ColumnKey): number => {
    if (dragWidth?.column === column) return dragWidth.width;
    if (column === 'actions') return Math.max(CONTENT_WIDTHS.actions, widths.actions - liveDelta);
    return widths[column];
  };

  const dragging = dragWidth !== null;
  useEffect(() => {
    if (!dragging) return;
    const widthFrom = (event: MouseEvent): number => {
      const drag = dragRef.current;
      if (!drag) return MIN_COLUMN_WIDTH;
      return Math.max(MIN_COLUMN_WIDTH, drag.startWidth + event.clientX - drag.startX);
    };
    const onMove = (event: MouseEvent): void => {
      const drag = dragRef.current;
      if (drag) setDragWidth({ column: drag.column, width: widthFrom(event) });
    };
    const onUp = (event: MouseEvent): void => {
      const drag = dragRef.current;
      // Persisted once, on release: a write per mousemove would hammer
      // localStorage sixty times a second for one drag.
      if (drag) setWidth(drag.column, widthFrom(event));
      dragRef.current = null;
      setDragWidth(null);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging, setWidth]);

  const ordered = useMemo(() => sortSongs(songs, sort), [songs, sort]);
  // Search results span the whole library, so they are not a member list of
  // the playlist that happens to be selected (§4.1).
  const removableFrom = search === '' && playlistId !== VIRTUAL_ALL_PLAYLIST_ID ? playlistId : null;

  async function confirmDelete(): Promise<void> {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    try {
      await deleteSong(target.id);
      toast.success(`已删除：${target.name}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const totalWidth = visible.reduce((sum, column) => sum + widthOf(column), 0);

  return (
    <div ref={containerRef} className="relative flex-1 overflow-auto">
      <table className="table-fixed text-sm" style={{ width: totalWidth, minWidth: '100%' }}>
        <colgroup>
          {visible.map((column) => (
            <col key={column} style={{ width: widthOf(column) }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-background">
          <tr className="text-left text-muted-foreground">
            {visible.map((column) => (
              <th
                key={column}
                scope="col"
                className={`relative px-3 py-2 font-medium ${
                  column === 'index' ? 'text-center' : ''
                } ${column === 'duration' || column === 'fileSize' ? 'text-right' : ''}`}
              >
                {COLUMN_HEADERS[column]}
                {column !== 'actions' && (
                  // Pointer-only affordance, so it stays out of the
                  // accessibility tree rather than pretending to be operable
                  // from the keyboard.
                  <span
                    aria-hidden="true"
                    data-testid={`resize-${column}`}
                    className="absolute top-0 right-0 bottom-0 w-[2px] cursor-col-resize bg-border hover:bg-primary"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      dragRef.current = {
                        column,
                        startX: event.clientX,
                        startWidth: widthOf(column),
                      };
                      setDragWidth({ column, width: widthOf(column) });
                    }}
                  />
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.length === 0 ? (
            <tr>
              <td colSpan={visible.length} className="py-12 text-center text-muted-foreground">
                {error !== null
                  ? `加载失败：${error}`
                  : loading
                    ? '加载中…'
                    : search !== ''
                      ? '没有匹配的歌曲'
                      : '暂无歌曲'}
              </td>
            </tr>
          ) : (
            ordered.map((song, position) => (
              <SongRow
                key={song.id}
                song={song}
                index={position + 1}
                columns={columns}
                isSelected={song.id === selectedSongId}
                isCurrent={song.id === currentSongId}
                removableFrom={removableFrom}
                onPlay={onPlay}
                onRequestDelete={setPendingDelete}
              />
            ))
          )}
        </tbody>
      </table>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除歌曲"
        description={`确定删除「${pendingDelete?.name ?? ''}」吗？音频与歌词文件会一并移入废纸篓。`}
        confirmLabel="删除"
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
