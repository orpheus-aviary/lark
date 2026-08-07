// One library row: cells, inline editing, the actions cell and the right-click
// menu whose visibility rules are frozen in §4.1.

import type { PlaylistData, SongData, UpdateSongRequest } from '@lark/shared';
import { ListMinus, ListPlus, Play, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useBatchActions } from '../hooks/useBatchActions.js';
import { errorMessage } from '../lib/errors.js';
import { formatDateTime, formatDuration, formatFileSize } from '../lib/format.js';
import { getPlatform } from '../platform/index.js';
import { useLibrary } from '../stores/library.js';
import { usePlaylists, userPlaylists } from '../stores/playlists.js';
import type { ColumnVisibility } from '../stores/view-prefs.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Button } from './ui/button.js';
import { Checkbox } from './ui/checkbox.js';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './ui/context-menu.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';

type EditField = 'name' | 'artist';

interface SongActions {
  /** Add targets: user playlists only — the virtual `all` is never one (§4.1). */
  targets: readonly PlaylistData[];
  addTo: (playlist: PlaylistData) => void;
  removeFrom: (playlistId: string) => void;
  redownloadLyrics: () => void;
  deleteLyrics: () => void;
  copyId: () => void;
  copyLink: () => void;
  openLink: () => void;
  togglePin: () => void;
  redownload: () => void;
}

/** Every daemon call a row can make, each reporting through one toast. */
function useSongActions(song: SongData): SongActions {
  const playlists = usePlaylists((s) => s.playlists);
  const addSongs = usePlaylists((s) => s.addSongs);
  const removeSong = usePlaylists((s) => s.removeSong);
  const redownloadLyrics = useLibrary((s) => s.redownloadLyrics);
  const deleteLyrics = useLibrary((s) => s.deleteLyrics);
  const setPinned = useLibrary((s) => s.setPinned);
  const redownload = useLibrary((s) => s.redownload);

  const run = (action: () => Promise<void>, success: string): void => {
    void action().then(
      () => toast.success(success),
      (err: unknown) => toast.error(errorMessage(err)),
    );
  };

  return {
    targets: userPlaylists(playlists),
    addTo: (playlist) =>
      run(() => addSongs(playlist.id, [song.id]), `已添加到「${playlist.name}」`),
    removeFrom: (playlistId) => run(() => removeSong(playlistId, song.id), '已从当前歌单移除'),
    redownloadLyrics: () => run(() => redownloadLyrics(song.id), '已开始重新下载歌词'),
    deleteLyrics: () => run(() => deleteLyrics(song.id), '歌词已删除'),
    copyId: () =>
      void navigator.clipboard?.writeText(song.id).then(
        () => toast.success(`已复制歌曲 ID：${song.id}`),
        () => toast.error('复制失败'),
      ),
    copyLink: () => {
      if (song.source_url === null) return;
      void navigator.clipboard?.writeText(song.source_url).then(
        () => toast.success('已复制链接'),
        () => toast.error('复制失败'),
      );
    },
    // Through main, which applies the same http(s)-only gate the window-open
    // handler does (R10) — a link may have come from an import or a sync.
    openLink: () => {
      if (song.source_url === null) return;
      void getPlatform()
        .openExternal(song.source_url)
        .then((opened) => {
          if (!opened) toast.error('这个链接无法在浏览器中打开');
        });
    },
    togglePin: () =>
      run(
        () => setPinned(song.id, !song.pinned),
        song.pinned ? '已取消固定' : '已固定，不会被缓存清理',
      ),
    // No client-side guard for "no key and no LLM": the daemon answers 400
    // with the reason, and that is the same path every other action takes.
    redownload: () => run(() => redownload(song.id), '已开始重新下载'),
  };
}

interface EditableCellProps {
  value: string;
  display: React.ReactNode;
  /** Called with the trimmed draft; the caller decides what is worth writing. */
  onCommit: (value: string) => void;
}

/** Double-click to edit, Enter/blur to commit, Escape to abandon (D7). */
function EditableCell({ value, display, onCommit }: EditableCellProps): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Only the transition into editing matters; later keystrokes must not
  // re-select the text under the caret.
  const editing = draft !== null;

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (draft === null) {
    return (
      <button
        type="button"
        className="block w-full truncate text-left"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(value);
        }}
      >
        {display}
      </button>
    );
  }

  // Cleared before the callback so Enter's commit and the blur it causes
  // cannot both write.
  const commit = (): void => {
    setDraft(null);
    onCommit(draft.trim());
  };

  return (
    <input
      ref={inputRef}
      className="w-full border-primary border-b bg-transparent outline-none"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

interface RowActionProps {
  song: SongData;
  actions: SongActions;
  removableFrom: string | null;
  onPlay: (song: SongData) => void;
  onRequestDelete: (song: SongData) => void;
  onEditLink: (song: SongData) => void;
}

interface RowMenuProps extends RowActionProps {
  /** True when this row is part of a MULTI selection (B-4). */
  inSelection: boolean;
}

/** The Go six plus `播放` (master plan §5.4), rendered under §4.1's rules. */
function SongContextMenu({
  song,
  actions,
  removableFrom,
  onPlay,
  onRequestDelete,
  onEditLink,
  inSelection,
}: RowMenuProps): React.JSX.Element {
  const batch = useBatchActions();
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  // Right-clicking one of several selected rows acts on all of them (B-4).
  // Anything inherently single — play, copy, edit this link — stays single
  // however many rows are selected.
  const many = inSelection && batch.count > 1;
  const suffix = many ? ` ${batch.count} 首` : '';

  return (
    <>
      <ContextMenuContent className="w-44">
        {many && (
          <>
            <ContextMenuLabel>已选 {batch.count} 首</ContextMenuLabel>
            <ContextMenuSeparator />
          </>
        )}
        {/* A missing file downloads and then plays (M5-9), so nothing here is
          disabled — the `[需要下载]` marker is the only hint needed. */}
        <ContextMenuItem onSelect={() => onPlay(song)}>播放</ContextMenuItem>
        {actions.targets.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>添加到歌单{suffix}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {actions.targets.map((playlist) => (
                <ContextMenuItem
                  key={playlist.id}
                  onSelect={() => (many ? batch.addTo(playlist) : actions.addTo(playlist))}
                >
                  {playlist.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {removableFrom !== null && (
          <ContextMenuItem
            onSelect={() => (many ? batch.removeFromCurrent() : actions.removeFrom(removableFrom))}
          >
            从当前列表移除{suffix}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={actions.redownloadLyrics}>重新下载歌词</ContextMenuItem>
        <ContextMenuItem onSelect={actions.deleteLyrics}>删除歌词</ContextMenuItem>
        <ContextMenuItem onSelect={actions.copyId}>复制歌曲 ID</ContextMenuItem>
        <ContextMenuSeparator />
        {/* The link three (M5-10). Copy/open need a link to work with; editing
          one is how a song without a link gets one. */}
        <ContextMenuItem disabled={song.source_url === null} onSelect={actions.copyLink}>
          复制链接
        </ContextMenuItem>
        <ContextMenuItem disabled={song.source_url === null} onSelect={actions.openLink}>
          打开链接
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onEditLink(song)}>编辑链接…</ContextMenuItem>
        {many ? (
          <>
            <ContextMenuItem onSelect={() => batch.pin(true)}>固定{suffix}</ContextMenuItem>
            <ContextMenuItem onSelect={() => batch.pin(false)}>取消固定{suffix}</ContextMenuItem>
          </>
        ) : (
          <ContextMenuItem onSelect={actions.togglePin}>
            {song.pinned ? '取消固定' : '固定'}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={actions.redownload}>重新下载</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onSelect={() => (many ? setConfirmBatchDelete(true) : onRequestDelete(song))}
        >
          删除歌曲{suffix}
        </ContextMenuItem>
      </ContextMenuContent>

      <ConfirmDialog
        open={confirmBatchDelete}
        title="删除歌曲"
        description={`确定删除选中的 ${batch.count} 首吗？音频与歌词文件会一并移入废纸篓。`}
        confirmLabel="删除"
        destructive
        onConfirm={() => {
          setConfirmBatchDelete(false);
          batch.deleteSelected();
        }}
        onCancel={() => setConfirmBatchDelete(false)}
      />
    </>
  );
}

interface ActionsCellProps extends RowActionProps {
  /** Hover-only unless this row is the selected one (Go behaviour). */
  alwaysVisible: boolean;
}

function SongActionsCell({
  song,
  actions,
  removableFrom,
  onPlay,
  onRequestDelete,
  alwaysVisible,
}: ActionsCellProps): React.JSX.Element {
  const stop = (e: React.MouseEvent): void => e.stopPropagation();
  return (
    <div
      className={`flex items-center justify-center gap-0.5 ${
        alwaysVisible ? '' : 'opacity-0 group-hover:opacity-100'
      }`}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`播放 ${song.name}`}
        onClick={(e) => {
          stop(e);
          onPlay(song);
        }}
      >
        <Play />
      </Button>
      {actions.targets.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`添加 ${song.name} 到歌单`}
              onClick={stop}
            >
              <ListPlus />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.targets.map((playlist) => (
              <DropdownMenuItem key={playlist.id} onSelect={() => actions.addTo(playlist)}>
                {playlist.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {removableFrom !== null && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`从当前歌单移除 ${song.name}`}
          onClick={(e) => {
            stop(e);
            actions.removeFrom(removableFrom);
          }}
        >
          <ListMinus />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="text-destructive"
        aria-label={`删除 ${song.name}`}
        onClick={(e) => {
          stop(e);
          onRequestDelete(song);
        }}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

/**
 * What a sortable wrapper hands the row (T7). The row itself knows nothing
 * about dnd-kit: it renders the `<tr>`, so it is the only place the drag ref
 * and the pointer listeners can land.
 */
export interface RowDragHandle {
  ref: (node: HTMLElement | null) => void;
  style: React.CSSProperties;
  /** dnd-kit's `attributes` + pointer `listeners`, spread onto the row. */
  handleProps: React.HTMLAttributes<HTMLTableRowElement>;
  isDragging: boolean;
}

export interface SongRowProps {
  song: SongData;
  /** Display position, 1-based. */
  index: number;
  columns: ColumnVisibility;
  isSelected: boolean;
  isCurrent: boolean;
  /**
   * Playlist this row can be removed FROM, or `null` when the view is not a
   * member list — the virtual `all` and search results both qualify (§4.1).
   */
  removableFrom: string | null;
  onPlay: (song: SongData) => void;
  onRequestDelete: (song: SongData) => void;
  onEditLink: (song: SongData) => void;
  /**
   * What a click on this row means. Handed down because only the list knows
   * the DISPLAYED order a Shift range runs over (B-3).
   */
  onSelect: (event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  /** Toggle just this row — the checkbox, and a right-click from outside. */
  onToggleSelected: () => void;
  /** Present only while the list is in its manual, draggable order (R24). */
  drag?: RowDragHandle;
}

export function SongRow({
  song,
  index,
  columns,
  isSelected,
  isCurrent,
  removableFrom,
  onPlay,
  onRequestDelete,
  onEditLink,
  onSelect,
  onToggleSelected,
  drag,
}: SongRowProps): React.JSX.Element {
  const updateSong = useLibrary((s) => s.updateSong);
  const actions = useSongActions(song);
  const menuProps = { song, actions, removableFrom, onPlay, onRequestDelete, onEditLink };
  const menuPropsWithSelection = { ...menuProps, inSelection: isSelected };

  const commitEdit = (field: EditField, value: string): void => {
    // An emptied song name is discarded; an emptied artist is a real value.
    if (field === 'name' && value === '') return;
    if (value === song[field]) return;
    const patch: UpdateSongRequest = field === 'name' ? { name: value } : { artist: value };
    void updateSong(song.id, patch).catch((err: unknown) => toast.error(errorMessage(err)));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <tr
          // Spread first: the row's own handlers and identity always win over
          // whatever the drag handle brings.
          {...drag?.handleProps}
          ref={drag?.ref}
          style={drag?.style}
          data-testid={`song-row-${song.id}`}
          data-current={isCurrent || undefined}
          data-dragging={drag?.isDragging || undefined}
          tabIndex={0}
          // Four states, four channels that never collide: the amber is
          // playing, the bar is selected, bold is pinned, and the red suffix
          // is "no file". `text-primary` used to mean playing and was
          // invisible — the neutral palette makes it body-text black.
          className={`group cursor-pointer hover:bg-accent ${isSelected ? 'bg-accent' : ''} ${
            isCurrent ? 'text-state-active' : song.has_file ? '' : 'text-muted-foreground'
          } ${drag?.isDragging === true ? 'relative z-10 bg-accent opacity-90 shadow-sm' : ''}`}
          onClick={onSelect}
          // A right-click INSIDE the selection keeps it (the menu then acts on
          // all of it); outside, it resets to this row — Finder's rule (B-4).
          onContextMenu={() => {
            if (!isSelected) onSelect({ metaKey: false, ctrlKey: false, shiftKey: false });
          }}
          onDoubleClick={() => onPlay(song)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
            onSelect({ metaKey: false, ctrlKey: false, shiftKey: false });
            onPlay(song);
          }}
        >
          {/* The selection bar rides on the first CELL, not the row: a <tr>
              border is at the mercy of border-collapse. Always 2px, so
              selecting a row never shifts its contents sideways. */}
          <td
            className={`border-l-2 px-2 py-1.5 text-center ${
              isSelected ? 'border-l-primary' : 'border-l-transparent'
            }`}
          >
            <Checkbox
              checked={isSelected}
              aria-label={`选择 ${song.name}`}
              // Without this the row's own onClick fires too and collapses the
              // selection to this one row — the exact opposite of ticking it.
              onClick={(event) => event.stopPropagation()}
              onCheckedChange={onToggleSelected}
            />
          </td>
          <td className="px-3 py-1.5 text-center tabular-nums">{index}</td>
          <td className="overflow-hidden px-3 py-1.5">
            <EditableCell
              value={song.name}
              display={
                <>
                  {/* Bold = pinned, i.e. "the cache may never reclaim this". */}
                  <span className={song.pinned ? 'font-semibold' : ''}>{song.name}</span>
                  {!song.has_file && (
                    <span className="ml-1 text-destructive text-xs">[需要下载]</span>
                  )}
                </>
              }
              onCommit={(value) => commitEdit('name', value)}
            />
          </td>
          <td className="overflow-hidden px-3 py-1.5">
            <EditableCell
              value={song.artist}
              display={
                song.artist === '' ? (
                  <span className="text-muted-foreground italic">未知歌手</span>
                ) : (
                  song.artist
                )
              }
              onCommit={(value) => commitEdit('artist', value)}
            />
          </td>
          {columns.duration && (
            <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">
              {song.duration > 0 ? formatDuration(song.duration) : ''}
            </td>
          )}
          {columns.fileSize && (
            <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">
              {formatFileSize(song.file_size)}
            </td>
          )}
          {columns.createdAt && (
            <td className="px-3 py-1.5 text-muted-foreground">{formatDateTime(song.created_at)}</td>
          )}
          <td className="px-3 py-1.5">
            <SongActionsCell {...menuProps} alwaysVisible={isSelected} />
          </td>
        </tr>
      </ContextMenuTrigger>

      <SongContextMenu {...menuPropsWithSelection} />
    </ContextMenu>
  );
}
