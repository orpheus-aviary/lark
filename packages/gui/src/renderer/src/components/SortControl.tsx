// The split sort button (D5): the left half walks the seven-state cycle, the
// right half opens the same seven states as a menu.

import {
  ArrowDown01,
  ArrowDownAZ,
  ArrowUp01,
  ArrowUpAZ,
  ArrowUpDown,
  ChevronDown,
} from 'lucide-react';
import {
  SORT_CYCLE,
  SORT_FIELD_LABELS,
  type SortState,
  isSameSort,
  sortLabel,
} from '../lib/song-sort.js';
import { useViewPrefs } from '../stores/view-prefs.js';
import { Button } from './ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';

function iconFor(sort: SortState): typeof ArrowUpDown {
  if (sort.field === 'default') return ArrowUpDown;
  if (sort.field === 'created_at') return sort.order === 'asc' ? ArrowUp01 : ArrowDown01;
  return sort.order === 'asc' ? ArrowUpAZ : ArrowDownAZ;
}

export function SortControl(): React.JSX.Element {
  const sort = useViewPrefs((s) => s.sort);
  const cycleSort = useViewPrefs((s) => s.cycleSort);
  const setSort = useViewPrefs((s) => s.setSort);
  const Icon = iconFor(sort);

  return (
    <div className="flex items-stretch">
      <Button
        variant="secondary"
        size="sm"
        className="rounded-r-none"
        title={`排序：${sortLabel(sort)}（点击切换）`}
        onClick={cycleSort}
      >
        <Icon className="size-4" />
        <span>{SORT_FIELD_LABELS[sort.field]}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            aria-label="选择排序方式"
            className="rounded-l-none border-border border-l px-1.5"
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {SORT_CYCLE.map((option) => (
            <DropdownMenuItem
              key={`${option.field}-${option.order}`}
              className={isSameSort(option, sort) ? 'text-primary' : ''}
              onSelect={() => setSort(option)}
            >
              {sortLabel(option)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
