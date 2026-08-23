// What somebody shared, waiting for a screen to take it (N4d-3, decision e).
//
// IN MEMORY, AND THAT IS THE DECISION. The payload behind it is volatile —
// `resetOnBackground` is expo-share-intent's default and MEASURED (N0b-4c) to
// clear both the hook's value and the native side the moment the app is
// backgrounded — so nothing here is a cache of something durable. Writing it to
// `local_metadata` would give it a lifetime the thing it describes never had:
// last week's share sitting in the paste box on a cold start (criterion 45).
//
// SEPARATE FROM THE HOOK (`intent.ts`) for the reason `downloads/rows.ts` is
// separate from its screen: this file imports NOTHING, so its rules — consumed
// once, cleared by the taking, announced to everyone — can be tested in a
// second instead of through a build-install-share cycle.

let draft: string | null = null;
const listeners = new Set<() => void>();

/** Is something waiting? For a component deciding which tab to open on. */
export function hasShareDraft(): boolean {
  return draft !== null;
}

/** Read AND clear. A draft is consumed once, by whoever gets there first. */
export function takeShareDraft(): string | null {
  const out = draft;
  draft = null;
  return out;
}

/** Empty and blank-only shares are not drafts; nothing downstream wants them. */
export function putShareDraft(text: string): void {
  if (text.trim() === '') return;
  draft = text;
  for (const listener of listeners) listener();
}

/**
 * Told that a share arrived, not what it was.
 *
 * Two listeners want different halves: the shell switches tab (and must NOT
 * consume, or the page it switches to would find nothing), the add page takes
 * the text. Keeping "there is one" and "here it is" as separate calls is what
 * lets both exist with no order dependency between them.
 */
export function subscribeShareDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
