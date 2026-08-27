// What the selection can be done to (S3/B-5, revised after acceptance).
//
// PERMANENT, not conditional: the buttons sit at the right end of the download
// bar's status line whether or not anything is selected, greyed out until it
// is. That costs one row of pixels the layout had already reserved, and buys
// discoverability — an action that only exists once you have already selected
// something is an action you have to be told about.
//
// The download's own status keeps the left of the same row; the two no longer
// take turns.
//
// Pin and unpin are two buttons rather than one toggle (B-6): a mixed
// selection has no single sensible flip, and both directions are idempotent.

import { X } from 'lucide-react';
import { useState } from 'react';
import { useBatchActions } from '../hooks/useBatchActions.js';
import { useLibrary } from '../stores/library.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Button } from './ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';

export function BatchActionBar(): React.JSX.Element {
  const clearSelection = useLibrary((s) => s.clearSelection);
  const batch = useBatchActions();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const empty = batch.count === 0;
  const idle = empty || batch.busy;

  return (
    <>
      {/* Pushes the whole group to the right edge, past the download status. */}
      <div className="flex-1" />
      {!empty && <span className="shrink-0 text-muted-foreground">已选 {batch.count} 首</span>}
      {batch.busy && <span className="shrink-0 text-muted-foreground">处理中…</span>}

      {/* Only the missing files (ensure-file), never a refetch of the whole
          selection — the forced one keeps its own name in the row menu. Live
          whenever anything is selected rather than dead when the selection is
          all here: the toast says which rows it skipped, and a button that
          greys itself out on a state the eye has to check row by row reads as
          broken. */}
      <Button variant="secondary" size="xs" disabled={idle} onClick={batch.download}>
        下载
      </Button>
      <Button variant="secondary" size="xs" disabled={idle} onClick={() => batch.pin(true)}>
        固定
      </Button>
      <Button variant="secondary" size="xs" disabled={idle} onClick={() => batch.pin(false)}>
        取消固定
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="xs" disabled={idle || batch.targets.length === 0}>
            添加到歌单
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {batch.targets.map((playlist) => (
            <DropdownMenuItem key={playlist.id} onSelect={() => batch.addTo(playlist)}>
              {playlist.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Rendered even where it cannot apply (the virtual `all`, a search):
          a toolbar that changes shape with the view is one you have to re-read
          every time. It just goes dead instead (B-9). */}
      <Button
        variant="secondary"
        size="xs"
        disabled={idle || batch.removableFrom === null}
        onClick={batch.removeFromCurrent}
      >
        从当前列表移除
      </Button>
      {/* Red only once it would do something; grey with the rest until then. */}
      <Button
        variant={empty ? 'secondary' : 'destructive'}
        size="xs"
        disabled={idle}
        onClick={() => setConfirmDelete(true)}
      >
        删除
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="清空选择"
        disabled={empty}
        onClick={clearSelection}
      >
        <X />
      </Button>

      <ConfirmDialog
        open={confirmDelete}
        title="删除歌曲"
        description={`确定删除选中的 ${batch.count} 首吗？音频与歌词文件会一并永久删除，不进废纸篓。`}
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
