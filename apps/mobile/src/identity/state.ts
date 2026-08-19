// D16's boot decision, as a pure function (§2.2.1).
//
// Three inputs, read with zero writes: is there a library file, what does
// SecureStore say, and what does the library itself claim. One verdict out.
// Nothing here opens, copies, mints or deletes anything — the sequence in
// `boot/` does all of that, and this decides which of it to do.
//
// It is pure because both review rounds found their bugs HERE rather than in
// the mechanism, and a table this small should be cheap to get wrong in a test
// instead of expensive to get wrong on a phone:
//
//   v1 → v2: the gate ran after the library was already open, so it protected
//            nothing.
//   v2 → v3: a fresh first launch never wrote an identity, so the SECOND
//            launch saw "a library with no identity" — the exact signature of
//            a restored library — and wiped the one it had just created.
//
// THE DISCRIMINANT IS THE LIBRARY FILE, NOT THE IDENTITY. That is the whole
// lesson of the second bug. "No identity" is what a restored library looks
// like, so it can never be the thing that means "brand new".

export type IdentityPurpose = 'fresh' | 'converge';

export interface IdentityIntent {
  id: string;
  purpose: IdentityPurpose;
}

export interface IdentityInputs {
  /** Does `songs.db` exist? The discriminant. */
  libraryExists: boolean;
  /** `lark.install_id` — the identity this install has finished claiming. */
  committed: string | null;
  /** `lark.install_intent` — an identity it was in the middle of claiming. */
  intent: IdentityIntent | null;
  /**
   * `local_metadata.install_id`, read from the zero-write copy.
   * `null` when the library has no such row or does not exist.
   */
  dbInstallId: string | null;
}

export type IdentityDecision =
  /** No library. Create one and claim a new identity for it. */
  | { action: 'fresh'; reason: string }
  /** This library is ours and says so. Touch nothing. */
  | { action: 'normal'; reason: string }
  /** This library is not ours. Claim it, and clear what belonged to whoever had it. */
  | { action: 'converge'; reason: string }
  /**
   * A previous launch crashed mid-claim. Redo it verbatim with the SAME id —
   * that is what makes the sequence idempotent rather than merely restartable.
   */
  | { action: 'resume'; purpose: IdentityPurpose; installId: string; reason: string };

/**
 * Decide, from the three zero-write reads.
 *
 * Order matters: an in-flight intent wins over everything, because every other
 * row describes a settled state and an intent means the last launch did not
 * settle.
 */
export function decideIdentity(inputs: IdentityInputs): IdentityDecision {
  const { libraryExists, committed, intent, dbInstallId } = inputs;

  if (intent !== null) {
    return {
      action: 'resume',
      purpose: intent.purpose,
      installId: intent.id,
      reason: `an intent to ${intent.purpose} was left in flight — redoing it with the same id`,
    };
  }

  if (!libraryExists) {
    // Note what is NOT consulted: a leftover committed id with no library is
    // an install whose data was cleared, and it gets a new identity like any
    // other new library. Reusing it would let a wiped install answer for the
    // one that came before it.
    return { action: 'fresh', reason: 'no library file' };
  }

  if (committed === null) {
    // A library with no identity beside it. This is EXACTLY the restored-library
    // signature: SecureStore keys do not survive a restore, and the database
    // does. Fail closed.
    return { action: 'converge', reason: 'a library exists but this install has no identity' };
  }

  if (dbInstallId === null) {
    return { action: 'converge', reason: 'the library carries no install_id' };
  }

  if (dbInstallId !== committed) {
    return {
      action: 'converge',
      reason: `the library belongs to install ${dbInstallId}, not to ${committed}`,
    };
  }

  return { action: 'normal', reason: 'the library is this install’s' };
}
