// Turning a drop into a reorder request (T7, R7).
//
// Kept as a pure function on purpose: jsdom reports every rect as zero, so the
// drag itself can only be judged in a real browser (spike, plan §8.4) — but
// "where does the song land, and which neighbours does that make it" is
// arithmetic, and arithmetic can be tested.
//
// The wire never carries a rank or an index (R7): ranks are sparse floats the
// daemon owns, and an index is stale the moment another window reorders the
// same list. What it carries is the pair of members the song ends up BETWEEN,
// read off the list AFTER the move — which is exactly the sequence-excluding-
// the-moved-row that `POST /playlists/:id/reorder` resolves against.

import type { PlaylistReorderRequest } from '@lark/shared';

export interface ReorderPlan<T> {
  /** The list as it should look immediately, before the daemon confirms. */
  next: T[];
  /** Body for `POST /playlists/:id/reorder`. */
  anchors: PlaylistReorderRequest;
}

/**
 * Move `movedId` to the position `targetId` currently occupies.
 *
 * `null` when the move is a no-op or names something that is not in the list —
 * the caller then sends nothing at all rather than a request the daemon would
 * have to reject.
 */
export function planReorder<T extends { id: string }>(
  items: readonly T[],
  movedId: string,
  targetId: string,
): ReorderPlan<T> | null {
  if (movedId === targetId) return null;
  const from = items.findIndex((item) => item.id === movedId);
  const to = items.findIndex((item) => item.id === targetId);
  if (from === -1 || to === -1) return null;

  const next = [...items];
  next.splice(to, 0, ...next.splice(from, 1));

  const at = next.findIndex((item) => item.id === movedId);
  const after = at > 0 ? next[at - 1] : null;
  const before = at < next.length - 1 ? next[at + 1] : null;

  return {
    next,
    anchors: {
      song_id: movedId,
      // Both are sent when both exist: the daemon takes the midpoint of two
      // adjacent members, which is the only unambiguous reading of "here".
      ...(after === null ? {} : { after_song_id: after.id }),
      ...(before === null ? {} : { before_song_id: before.id }),
    },
  };
}
