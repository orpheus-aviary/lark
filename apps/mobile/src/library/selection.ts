// Which rows are ticked — the whole model, as pure functions over a Set
// (N4f-1, moved here in N4i-2).
//
// §1.5's 5000-row list is why the state is ONE set at the top of a screen
// rather than a `useState` inside each row: a `FlatList` recycles rows, so
// per-row state is state that is re-created as you scroll, and "全选" would
// have to reach into components that are not mounted. One set answers every
// question here in O(1).
//
// KEYED BY A STRING THE CALLER CHOOSES, and that is why this file is not in
// `downloads/` any more. It was written for the download picker (key = bvid,
// so a folder holding the same video twice has one row and downloads once);
// N4i's selection mode ticks SONGS with the same functions (key = song id).
// What every caller owes this file is a stable key; what the key means is the
// caller's business.

/** Anything this file can tick: it needs an identity and nothing else. */
export interface Pickable {
  key: string;
}

/** Everything ticked — how a freshly expanded list arrives (N4f decision e). */
export function chooseAll(rows: readonly Pickable[]): ReadonlySet<string> {
  return new Set(rows.map((row) => row.key));
}

/** One row's checkbox. A new set every time: React compares by identity. */
export function toggleOne(chosen: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(chosen);
  if (!next.delete(key)) next.add(key);
  return next;
}

/**
 * The header's single button, which is 全不选 when everything is ticked and
 * 全选 otherwise (the desktop's `toggleAll`, same rule).
 *
 * "Everything" is counted against the rows, not against the set: a set holding
 * a key that is not in this list would otherwise make a full selection look
 * partial forever. On the songs tab that is not hypothetical — searching
 * narrows the rows while the selection stays.
 */
export function toggleEvery(
  chosen: ReadonlySet<string>,
  rows: readonly Pickable[],
): ReadonlySet<string> {
  return allChosen(chosen, rows) ? new Set() : chooseAll(rows);
}

/** Whether every row is ticked — the label on that button. */
export function allChosen(chosen: ReadonlySet<string>, rows: readonly Pickable[]): boolean {
  return rows.length > 0 && rows.every((row) => chosen.has(row.key));
}

/** What a submission would carry: the ticked rows, in the source's own order. */
export function chosenRows<T extends Pickable>(
  rows: readonly T[],
  chosen: ReadonlySet<string>,
): readonly T[] {
  return rows.filter((row) => chosen.has(row.key));
}
