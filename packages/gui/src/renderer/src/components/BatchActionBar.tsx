// What the selection can be done to (S3/B-5).
//
// Lives in the download bar's status line, which has been a reserved
// fixed-height row since M4 — so switching between "downloading…" and this
// costs no layout at all. A selection wins the row while it exists; the
// download's own progress stays reachable in the tasks popover.
//
// Pin and unpin are two buttons rather than one toggle (B-6): a mixed
// selection has no single sensible flip, and both directions are idempotent.

import { X } from 'lucide-react';
import { useState } from 'react';
import { useBatchActions } from '../hooks/useBatchActions.js';
import { useLibrary } from '../stores/library.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';

interface ActionProps {
  children: React.ReactNode;
  disabled: boolean;
  destructive?: boolean;
  onClick: () => void;
}

/** A text button, not a real one: the row it lives in is 24px tall. */
function Action({ children, disabled, destructive, onClick }: ActionProps): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`shrink-0 hover:underline disabled:opacity-50 disabled:hover:no-underline ${
        destructive === true ? 'text-destructive' : ''
      }`}
    >
      {children}
    </button>
  );
}

export function BatchActionBar(): React.JSX.Element {
  const clearSelection = useLibrary((s) => s.clearSelection);
  const batch = useBatchActions();
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <>
      <span className="shrink-0 text-muted-foreground">已选 {batch.count} 首</span>
      <Action disabled={batch.busy} onClick={() => batch.pin(true)}>
        固定
      </Action>
      <Action disabled={batch.busy} onClick={() => batch.pin(false)}>
        取消固定
      </Action>
      {batch.targets.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" disabled={batch.busy} className="shrink-0 hover:underline">
              添加到歌单
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {batch.targets.map((playlist) => (
              <DropdownMenuItem key={playlist.id} onSelect={() => batch.addTo(playlist)}>
                {playlist.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {batch.removableFrom !== null && (
        <Action disabled={batch.busy} onClick={batch.removeFromCurrent}>
          从当前列表移除
        </Action>
      )}
      <Action destructive disabled={batch.busy} onClick={() => setConfirmDelete(true)}>
        删除
      </Action>
      {batch.busy && <span className="shrink-0 text-muted-foreground">处理中…</span>}

      <div className="flex-1" />
      <button
        type="button"
        aria-label="清空选择"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={clearSelection}
      >
        <X className="size-3.5" />
      </button>

      <ConfirmDialog
        open={confirmDelete}
        title="删除歌曲"
        description={`确定删除选中的 ${batch.count} 首吗？音频与歌词文件会一并移入废纸篓。`}
        confirmLabel="删除"
        destructive
        onConfirm={() => {
          setConfirmDelete(false);
          batch.deleteSelected();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
