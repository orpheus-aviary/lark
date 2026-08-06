// Live `GET /audio` streams, counted per song (M5-5 ①).
//
// M2 kept a single module-level integer, which was enough for the fd budget
// and the leak assertion. Eviction needs more: "is anyone reading THIS song
// right now" is the question, and a module global is shared by every
// AppContext in a test file (and by any second daemon instance in-process),
// so one test's leftover stream would silently protect another's song.
//
// The counter is registered at the very top of the handler, before any await.
// Registering after the `stat` would leave a window where the request has been
// accepted but is invisible to eviction: the file could be unlinked and the
// stream would open on a path that no longer exists.

/** Release a registration. Idempotent — `close` and `error` can both fire. */
export type ReleaseStream = () => void;

export class AudioStreamRegistry {
  readonly #counts = new Map<string, number>();

  register(songId: string): ReleaseStream {
    this.#counts.set(songId, (this.#counts.get(songId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.#counts.get(songId) ?? 1) - 1;
      if (next <= 0) this.#counts.delete(songId);
      else this.#counts.set(songId, next);
    };
  }

  count(songId: string): number {
    return this.#counts.get(songId) ?? 0;
  }

  /** Every open stream. Must be 0 once all responses have settled. */
  total(): number {
    let sum = 0;
    for (const count of this.#counts.values()) sum += count;
    return sum;
  }
}
