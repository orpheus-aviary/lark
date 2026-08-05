// Display preferences of the library view: which optional columns show, how
// wide the resized ones are, and the sort state (D3/D4/D5 — all three are
// persisted here, unlike the Go version which forgot them on every restart).

import { create } from 'zustand';
import { asWidthMap, readPref, writePref } from '../lib/prefs.js';
import { DEFAULT_SORT, SORT_CYCLE, type SortState, nextSort } from '../lib/song-sort.js';

export const OPTIONAL_COLUMNS = ['duration', 'fileSize', 'createdAt'] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export type ColumnVisibility = Record<OptionalColumn, boolean>;

const PREF_VERSION = 1;
const COLUMNS_KEY = 'library.columns';
const WIDTHS_KEY = 'library.columnWidths';
const SORT_KEY = 'library.sort';

/** Go default: all three optional columns start hidden. */
const DEFAULT_COLUMNS: ColumnVisibility = { duration: false, fileSize: false, createdAt: false };

function parseColumns(value: unknown): ColumnVisibility | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const out = { ...DEFAULT_COLUMNS };
  for (const key of OPTIONAL_COLUMNS) {
    if (key in record) {
      if (typeof record[key] !== 'boolean') return null;
      out[key] = record[key] as boolean;
    }
  }
  return out;
}

function parseSort(value: unknown): SortState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { field, order } = value as { field?: unknown; order?: unknown };
  const match = SORT_CYCLE.find((s) => s.field === field && s.order === order);
  return match ? { ...match } : null;
}

interface ViewPrefsState {
  columns: ColumnVisibility;
  /** Only columns the user actually dragged; the rest are laid out on the fly. */
  widths: Record<string, number>;
  sort: SortState;
  toggleColumn: (column: OptionalColumn) => void;
  setWidth: (column: string, width: number) => void;
  setSort: (sort: SortState) => void;
  cycleSort: () => void;
}

export const useViewPrefs = create<ViewPrefsState>((set, get) => ({
  columns: readPref(COLUMNS_KEY, PREF_VERSION, parseColumns, DEFAULT_COLUMNS),
  widths: readPref(WIDTHS_KEY, PREF_VERSION, asWidthMap, {}),
  sort: readPref(SORT_KEY, PREF_VERSION, parseSort, DEFAULT_SORT),

  toggleColumn: (column) => {
    const columns = { ...get().columns, [column]: !get().columns[column] };
    writePref(COLUMNS_KEY, PREF_VERSION, columns);
    // Widths survive a visibility toggle (D4): re-equalising here is what made
    // the Go version throw away a drag every time a checkbox moved.
    set({ columns });
  },

  setWidth: (column, width) => {
    const widths = { ...get().widths, [column]: width };
    writePref(WIDTHS_KEY, PREF_VERSION, widths);
    set({ widths });
  },

  setSort: (sort) => {
    writePref(SORT_KEY, PREF_VERSION, sort);
    set({ sort });
  },

  cycleSort: () => {
    get().setSort(nextSort(get().sort));
  },
}));
