// What the 添加 page is holding, kept somewhere the page itself is not (③).
//
// Three of the four tabs are unmounted the moment somebody looks at another
// one — that is the shell's design and it is right for the other two — so a
// half-typed link was gone by the time they came back. `openPlaylist` was
// lifted out of 歌单 for this exact reason ("a detail screen that forgot where
// it was every time you glanced at 设置 is a screen you stop using"); this is
// the same lift, one tab over.
//
// IN MEMORY ONLY, and that is the whole ask: still there if you did not leave
// the app. A file would give it a lifetime the thing it describes never had —
// the mistake `share/draft.ts` documents itself refusing to make.

export interface AddDraft {
  /** What is in the box. */
  readonly text: string;
  /** 存到 — `null` is the library with no playlist. */
  readonly playlistId: string | null;
}

export const EMPTY_ADD_DRAFT: AddDraft = { text: '', playlistId: null };

/**
 * A share replaces what was typed: receiving a link and finding the old text
 * still sitting there reads as not having received it.
 *
 * It says nothing about where the download should GO, though, so 存到 lives
 * through it — somebody who picked a playlist and then shared a link into the
 * app picked that playlist for this link too.
 */
export function shareArrived(draft: AddDraft, shared: string): AddDraft {
  return { ...draft, text: shared };
}

/**
 * Something was queued. The box empties — the next thing anybody wants to know
 * is whether it is coming down, not what they just pasted — and 存到 does not,
 * because adding three songs to one playlist is three submissions.
 */
export function submitted(draft: AddDraft): AddDraft {
  return { ...draft, text: '' };
}
