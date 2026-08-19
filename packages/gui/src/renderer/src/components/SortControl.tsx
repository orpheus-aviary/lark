// The split sort button: the left half flips the direction of the current
// field, the right half picks the field.
//
// Not the Go version's click-through cycle (D5, revised): five fields would
// make that a nine-state cycle, so getting back to `默认` would cost nine
// clicks. Two axes, two controls — and the left half is inert while `默认` is
// active, because "the daemon's order" has no direction to flip.

import {
  SORT_FIELDS,
  SORT_FIELD_LABELS,
  type SortState,
  isNumericField,
  sortLabel,
  withField,
} from '@lark/shared';
import {
  ArrowDown01,
  ArrowDownAZ,
  ArrowUp01,
  ArrowUpAZ,
  ArrowUpDown,
  ChevronDown,
} from 'lucide-react';
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
  if (isNumericField(sort.field)) return sort.order === 'asc' ? ArrowUp01 : ArrowDown01;
  return sort.order === 'asc' ? ArrowUpAZ : ArrowDownAZ;
}

export function SortControl(): React.JSX.Element {
  const sort = useViewPrefs((s) => s.sort);
  const toggleSortOrder = useViewPrefs((s) => s.toggleSortOrder);
  const setSort = useViewPrefs((s) => s.setSort);
  const Icon = iconFor(sort);
  const sortable = sort.field !== 'default';

  return (
    <div className="flex items-stretch">
      <Button
        variant="secondary"
        size="sm"
        className="rounded-r-none"
        disabled={!sortable}
        title={sortable ? `排序：${sortLabel(sort)}（点击切换升降序）` : '默认顺序不分升降序'}
        onClick={toggleSortOrder}
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
          {SORT_FIELDS.map((field) => (
            <DropdownMenuItem
              key={field}
              className={field === sort.field ? 'text-state-active' : ''}
              onSelect={() => setSort(withField(sort, field))}
            >
              {SORT_FIELD_LABELS[field]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
