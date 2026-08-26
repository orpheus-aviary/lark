// The no-backup side of D16 (decision l).
//
// SecureStore, because it is the one store on this device that does NOT come
// back after a restore: its keys live in the Keystore and never leave the
// phone (N0b-5a measured it — uninstall/reinstall reads nothing back). That
// asymmetry IS the mechanism: a database that returns while its identity does
// not is a database that came from somewhere else.
//
// TWO KEYS, and the difference between them is the whole crash story:
//
//   `lark.install_id`     — committed. The identity this install has finished
//                           claiming.
//   `lark.install_intent` — in flight. "I am part-way through claiming this."
//
// WRITE ORDER IS FROZEN: SecureStore first, the database second (§2.2.1). Not
// a preference — a choice about which lie is cheaper to be caught in. Crash
// after SecureStore and the next launch sees "an intent, no library", redoes
// it, and costs nothing. Crash after the database and the next launch sees "a
// library, no identity", which is indistinguishable from a restore — so it
// would converge, and wipe the library it had just created. That was v2's bug.
//
// `requireAuthentication: false` throughout: this runs before any UI exists,
// and a biometric prompt in the middle of a boot sequence is not a boot
// sequence.

import { deleteItemAsync, getItem, setItem } from 'expo-secure-store';
import { activeWorkspaceId } from '../ports/paths';
import { COMMITTED_KEY, INTENT_KEY, workspaceKey } from './keys';
import type { IdentityIntent, IdentityPurpose } from './state';

const OPTIONS = { requireAuthentication: false } as const;

// ONE PAIR OF KEYS PER WORKSPACE since N7d, and `local` keeps the unprefixed
// ones so an existing install is not asked to migrate (`keys.ts` says what
// happens if it were). The default is the workspace this process opened —
// there is only ever one — and boot passes it explicitly anyway, because a
// sequence that decides which library to claim should be seen naming it.
const committedKey = (workspaceId: string): string => workspaceKey(COMMITTED_KEY, workspaceId);
const intentKey = (workspaceId: string): string => workspaceKey(INTENT_KEY, workspaceId);

/** The identity this install has finished claiming, or `null`. */
export function readCommitted(workspaceId: string = activeWorkspaceId()): string | null {
  const value = getItem(committedKey(workspaceId), OPTIONS);
  return value === null || value === '' ? null : value;
}

function isPurpose(value: unknown): value is IdentityPurpose {
  return value === 'fresh' || value === 'converge';
}

/**
 * The in-flight intent, or `null` — including when what is stored cannot be
 * read as one.
 *
 * Treating garbage as absent is SAFE rather than lenient, and it is worth
 * saying why: the intent is written at step ⑤, before anything touches the
 * database, so the settled state at that moment is exactly the state the
 * decision table was going to see anyway. Falling through to it re-derives the
 * same verdict — a converge instead of a resumed converge, a fresh instead of
 * a resumed fresh. The intent buys idempotence (the same id twice), not
 * correctness.
 */
export function readIntent(workspaceId: string = activeWorkspaceId()): IdentityIntent | null {
  const raw = getItem(intentKey(workspaceId), OPTIONS);
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { id, purpose } = parsed as { id?: unknown; purpose?: unknown };
    if (typeof id !== 'string' || id === '' || !isPurpose(purpose)) return null;
    return { id, purpose };
  } catch {
    return null;
  }
}

/** Step ⑤. Always before the database is opened for writing. */
export function writeIntent(
  intent: IdentityIntent,
  workspaceId: string = activeWorkspaceId(),
): void {
  setItem(intentKey(workspaceId), JSON.stringify(intent), OPTIONS);
}

/**
 * Step ⑩: the identity is now this install's, and nothing is in flight.
 *
 * Committed first, intent cleared second. A crash between them leaves an
 * intent whose work is already done — and redoing it is idempotent by
 * construction, which is the reason the id travels in the intent at all.
 */
export async function commitIdentity(
  installId: string,
  workspaceId: string = activeWorkspaceId(),
): Promise<void> {
  setItem(committedKey(workspaceId), installId, OPTIONS);
  await deleteItemAsync(intentKey(workspaceId), OPTIONS);
}

/** Acceptance builds only — the fixtures need a way back to a blank slate. */
export async function forgetIdentity(workspaceId: string = activeWorkspaceId()): Promise<void> {
  await deleteItemAsync(committedKey(workspaceId), OPTIONS);
  await deleteItemAsync(intentKey(workspaceId), OPTIONS);
}
