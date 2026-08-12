// Conflicts (v0.2 T4, §4.6 / D4).
//
// A conflict record is a RECEIPT, not a merge. LWW already decided, the row
// already holds the remote value, and this table remembers what this device's
// own copy said so the user can put it back. So the two buttons are honest
// about what they do: 保留远端 only files the receipt away, 保留本机 writes the
// old values back and publishes them.
//
// Only the fields that DIFFER are listed. A conflict on a song's name should
// not make the user re-read its duration, and the difference is the entire
// question being asked.
//
// Every answer carries `expected_current` — the winner's LWW triple as the
// receipt recorded it. Between seeing a conflict and answering it a third
// device can write again, and restoring a local copy over THAT would undo a
// change nobody ever saw; the daemon refuses (409) and the list is refetched
// so the user decides against what is actually there.

import type { ConflictData, SongSyncPayload } from '@lark/shared';
import { ApiError } from '@lark/shared';
import { Fragment, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { formatDateTime, formatDuration } from '../lib/format.js';
import { useSync } from '../stores/sync.js';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

/** The song fields a conflict can be about, in the order the row shows them. */
const FIELDS: readonly {
  key: keyof SongSyncPayload;
  label: string;
  show: (payload: SongSyncPayload) => string;
}[] = [
  { key: 'name', label: '歌曲名称', show: (p) => p.name },
  { key: 'artist', label: '歌手', show: (p) => p.artist },
  { key: 'source_url', label: '来源链接', show: (p) => p.source_url ?? '—' },
  { key: 'duration', label: '时长', show: (p) => formatDuration(p.duration) },
  { key: 'lyrics_offset', label: '歌词偏移', show: (p) => `${p.lyrics_offset}s` },
];

function songTitle(conflict: ConflictData): string {
  return conflict.remote_payload?.name ?? conflict.local_payload?.name ?? conflict.entity_id;
}

function ConflictCard({
  conflict,
  busy,
  onResolve,
}: {
  conflict: ConflictData;
  busy: boolean;
  onResolve: (strategy: 'local' | 'remote') => void;
}): React.JSX.Element {
  const local = conflict.local_payload;
  const remote = conflict.remote_payload;
  const differing =
    local === null || remote === null
      ? FIELDS
      : FIELDS.filter((field) => local[field.key] !== remote[field.key]);

  return (
    <li className="space-y-2 rounded-md border border-border p-3 text-xs">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-sm">{songTitle(conflict)}</span>
        <span className="text-muted-foreground">{formatDateTime(conflict.detected_at)}</span>
      </div>

      {local === null || remote === null ? (
        <p className="text-muted-foreground">
          这条记录的内容已无法解析，只能确认它发生过；保留远端即可归档。
        </p>
      ) : (
        <div className="grid grid-cols-[6rem_1fr_1fr] gap-x-3 gap-y-1">
          <span />
          <span className="text-muted-foreground">本机的版本</span>
          <span className="text-muted-foreground">已生效（远端）</span>
          {differing.map((field) => (
            <Fragment key={field.key}>
              <span className="text-muted-foreground">{field.label}</span>
              <span className="break-all">{field.show(local)}</span>
              <span className="break-all">{field.show(remote)}</span>
            </Fragment>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy}
          aria-label={`保留本机版本：${songTitle(conflict)}`}
          onClick={() => onResolve('local')}
        >
          保留本机
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          aria-label={`保留远端版本：${songTitle(conflict)}`}
          onClick={() => onResolve('remote')}
        >
          保留远端
        </Button>
      </div>
    </li>
  );
}

export function ConflictsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const conflicts = useSync((s) => s.conflictList);
  const refreshConflictList = useSync((s) => s.refreshConflictList);
  const resolveConflict = useSync((s) => s.resolveConflict);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open) {
      setLoaded(false);
      return;
    }
    refreshConflictList();
    setLoaded(true);
  }, [open, refreshConflictList]);

  const resolve = async (conflict: ConflictData, strategy: 'local' | 'remote'): Promise<void> => {
    setBusyId(conflict.id);
    try {
      await resolveConflict(conflict.id, strategy, conflict.remote_key);
      toast.success(strategy === 'local' ? '已恢复本机的版本' : '已保留远端的版本');
    } catch (err) {
      if (err instanceof ApiError && err.errorCode === 'CONFLICT_VERSION_MISMATCH') {
        // Someone wrote again while this was on screen — re-ask rather than
        // bury a version the user never saw.
        toast.error('这首歌在此期间又被改过了，请对着最新的内容重新选择');
        refreshConflictList();
      } else {
        toast.error(errorMessage(err));
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>同步冲突</DialogTitle>
          <DialogDescription>
            两台设备同时改了同一首歌。远端的版本已经生效，这里可以把本机的版本改回去。
          </DialogDescription>
        </DialogHeader>

        {conflicts.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {loaded ? '没有待处理的冲突。' : '正在读取…'}
          </p>
        ) : (
          <ul className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            {conflicts.map((conflict) => (
              <ConflictCard
                key={conflict.id}
                conflict={conflict}
                busy={busyId === conflict.id}
                onResolve={(strategy) => void resolve(conflict, strategy)}
              />
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
