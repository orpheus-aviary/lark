// "The library changed" — one signal, readable from outside React (N3c, §2.8).
//
// `LibraryProvider.changed()` already existed and did one thing: rebuild the
// React view. Nothing outside the tree could hear it, and the player needs to
// — a song deleted while it is playing has to stop, and one deleted out of the
// queue has to leave it. Wiring the delete button straight to the player would
// work exactly until N5, when sync deletes a row with nobody's finger on a
// button.
//
// So: a set of listeners, not a protocol. When sync lands it emits the same
// signal, and everything already listening reconciles itself.

type Listener = () => void;

const listeners = new Set<Listener>();

export function onLibraryChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every write path calls this — today through `changed()` in the provider. */
export function libraryChanged(): void {
  for (const listener of listeners) listener();
}
