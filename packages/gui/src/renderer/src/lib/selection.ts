// Multi-selection arithmetic (S1). Pure on purpose: the awkward cases here
// are all about ORDER and ABSENCE — a range that runs upward, an anchor the
// last refresh deleted, a selection that outlived the view it was made in —
// and none of them need a DOM to get wrong.
//
// The selection is an ordered list rather than a Set because "add these to a
// playlist" appends in the order the user picked, and a Set would hand back
// insertion order that no longer means anything after a toggle.

/** Add the id, or drop it if it is already there (Cmd-click). */
export function toggleIn(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id];
}

/**
 * The ids from `anchor` to `target` inclusive, in DISPLAY order (Shift-click).
 *
 * `ordered` is the list as it appears on screen, so a range follows what the
 * user sees rather than what the daemon returned. An anchor that is no longer
 * in the list selects just the target — the alternative, selecting from the
 * top, would silently grab rows the user never pointed at.
 */
export function rangeBetween(
  ordered: readonly string[],
  anchor: string | null,
  target: string,
): string[] {
  const to = ordered.indexOf(target);
  if (to === -1) return [];
  const from = anchor === null ? -1 : ordered.indexOf(anchor);
  if (from === -1) return [target];
  const [start, end] = from <= to ? [from, to] : [to, from];
  return ordered.slice(start, end + 1);
}

/** Drop ids that are no longer in the library (a refresh may have deleted them). */
export function pruneMissing(ids: readonly string[], present: ReadonlySet<string>): string[] {
  return ids.filter((id) => present.has(id));
}

/** Every id is selected, and there is at least one. */
export function isAllSelected(ordered: readonly string[], selected: readonly string[]): boolean {
  if (ordered.length === 0) return false;
  const chosen = new Set(selected);
  return ordered.every((id) => chosen.has(id));
}

/** Some but not all — the header checkbox's third state. */
export function isPartiallySelected(
  ordered: readonly string[],
  selected: readonly string[],
): boolean {
  if (ordered.length === 0 || selected.length === 0) return false;
  return !isAllSelected(ordered, selected) && ordered.some((id) => selected.includes(id));
}
