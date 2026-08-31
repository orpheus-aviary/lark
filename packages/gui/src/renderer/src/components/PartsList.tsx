// The parts of one multi-part video, with a checkbox each (0.5.1 §7.3).
//
// 🔴 ONE MARKUP, TWO PLACES. This list appears inside `BatchSelectModal` (a
// pasted line that turned out to be multi-part) and inside `PartsPickerDialog`
// (a single link that was refused). Writing it twice is the mistake 0.5.0
// already paid for once — the playlist page and the library tab each had their
// own song row, and only one of them learned to say 「需要下载」 (backlog C12).
// Presentational on purpose: it owns no selection state and sends no request.

import type { DownloadPartData } from '@lark/shared';
import { Checkbox } from './ui/checkbox.js';

/** `M:SS`, or nothing at all when bilibili did not say (`duration: null`). */
function formatDuration(seconds: number | null): string {
  if (seconds === null) return '';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export interface PartsListProps {
  /** Distinguishes this list's checkbox ids from another's on the same page. */
  idPrefix: string;
  parts: readonly DownloadPartData[];
  /** The pages currently ticked. Empty is the opening state (§7.3-d). */
  checked: readonly number[];
  onToggle: (page: number) => void;
  onToggleAll: (checked: boolean) => void;
}

export function PartsList({
  idPrefix,
  parts,
  checked,
  onToggle,
  onToggleAll,
}: PartsListProps): React.JSX.Element {
  const allId = `${idPrefix}-all`;
  const allChecked = parts.length > 0 && checked.length === parts.length;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <Checkbox
          id={allId}
          checked={allChecked}
          onCheckedChange={(next) => onToggleAll(next === true)}
        />
        <label htmlFor={allId}>
          共 {parts.length} 个分P，已选 {checked.length}
        </label>
      </div>
      <ul className="max-h-64 overflow-y-auto">
        {parts.map((part) => {
          const id = `${idPrefix}-p${part.page}`;
          const duration = formatDuration(part.duration);
          return (
            <li key={part.page} className="flex items-center gap-2 py-0.5 text-sm">
              <Checkbox
                id={id}
                checked={checked.includes(part.page)}
                onCheckedChange={() => onToggle(part.page)}
              />
              <span className="w-8 shrink-0 text-muted-foreground text-xs">P{part.page}</span>
              <label htmlFor={id} className="min-w-0 flex-1 truncate">
                {part.part}
              </label>
              {duration !== '' && (
                <span className="shrink-0 text-muted-foreground text-xs">{duration}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
