// Who is allowed to touch a song's files right now (M3-7).
//
// Three writers can reach the same song directory: a download task replacing
// the audio, a lyrics task writing lyrics.lrc, and a route deleting the song
// outright. The Go version had no arbitration at all, so "delete a song while
// it is downloading" was a race whose outcome depended on timing.
//
// The model is one registry keyed by song, holding (type, owner) pairs:
//
//   file       — writes song.mp3 (download, redownload, a source edit)
//   lyrics     — writes or deletes lyrics.lrc
//   exclusive  — deleting the song; conflicts with everything, including
//                other exclusives
//
// `file` and `lyrics` deliberately coexist: fetching lyrics for a song has
// nothing to say about replacing its audio, and making them exclusive would
// serialise the two halves of every download for no reason.
//
// Ownership is what makes queue promotion work. A queued task registers a
// reservation under its own task id; when it starts running it acquires the
// real claim under the SAME owner, and an owner never blocks itself (fifth
// review ③). Without that, every task would deadlock against its own
// reservation the moment it started.

import { SongBusyError } from '../errors.js';

export const CLAIM_TYPES = ['file', 'lyrics', 'exclusive'] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** Proof of ownership. `release` without one is not possible by construction. */
export interface ClaimToken {
  readonly songId: string;
  readonly type: ClaimType;
  readonly owner: string;
}

interface Held {
  type: ClaimType;
  owner: string;
  token: ClaimToken;
}

/** Does an existing claim of type `held` block a new one of type `wanted`? */
function conflicts(held: ClaimType, wanted: ClaimType): boolean {
  if (held === 'exclusive' || wanted === 'exclusive') return true;
  return held === wanted;
}

export class ClaimRegistry {
  readonly #held = new Map<string, Held[]>();

  /**
   * Take a claim, or throw `SongBusyError`.
   *
   * Synchronous and total: the caller runs this inside the engine's critical
   * section, so between the check and the insert nothing else can run. An
   * async acquire would reintroduce exactly the race it exists to prevent.
   */
  acquire(songId: string, type: ClaimType, owner: string): ClaimToken {
    const current = this.#held.get(songId) ?? [];
    const blocker = current.find((h) => h.owner !== owner && conflicts(h.type, type));
    if (blocker !== undefined) {
      throw new SongBusyError(songId, `${blocker.type} held by ${blocker.owner}`);
    }
    const token: ClaimToken = { songId, type, owner };
    current.push({ type, owner, token });
    this.#held.set(songId, current);
    return token;
  }

  /** Give a claim back. Idempotent — a double release is not an error. */
  release(token: ClaimToken): void {
    const current = this.#held.get(token.songId);
    if (current === undefined) return;
    const at = current.findIndex((h) => h.token === token);
    if (at === -1) return;
    current.splice(at, 1);
    if (current.length === 0) this.#held.delete(token.songId);
  }

  /**
   * Drop everything an owner holds. The `finally` path of a task: it may hold
   * a reservation, a claim, or both, and after an unexpected throw it cannot
   * be trusted to know which (fourth review ⑨).
   */
  releaseOwner(owner: string): void {
    for (const [songId, current] of this.#held) {
      const kept = current.filter((h) => h.owner !== owner);
      if (kept.length === current.length) continue;
      if (kept.length === 0) this.#held.delete(songId);
      else this.#held.set(songId, kept);
    }
  }

  /** Who holds what, for diagnostics and tests. */
  describe(songId: string): { type: ClaimType; owner: string }[] {
    return (this.#held.get(songId) ?? []).map((h) => ({ type: h.type, owner: h.owner }));
  }

  get size(): number {
    return this.#held.size;
  }
}
