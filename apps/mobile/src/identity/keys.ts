// Which SecureStore keys belong to which workspace (N7d, criterion 113).
//
// Before N7 a phone had one library, so the keys that describe it needed no
// name beyond their own. Now it can have several, and two of them sharing a
// key is not a cosmetic problem: `convergeLibrary` DELETES the credentials of
// the library it is claiming, so an unscoped key would mean adopting one
// workspace logs the other one out — and D16's `install_id` is worse, because
// a committed id belonging to workspace A read while opening workspace B is
// the exact signature of a restored library, which is the state that wipes.
//
// 🔴 `local` KEEPS THE ORIGINAL KEYS, unprefixed, and that is the whole of
// §2.4's "the phone does not migrate". An existing install boots into `local`;
// if its identity had moved to a new key it would find none, see a library
// that claims an id, and CONVERGE — throwing away the outbox of a library
// nobody touched. Zero migration is not a convenience here, it is the
// difference between a silent upgrade and a silent data loss.
//
// WHAT IS NOT SCOPED: `lark.llm.api_key`. §4's table puts the model on the
// DEVICE, and the key is the one part of it that cannot live in `device.json`
// — a secret does not belong in a plain file. It stays exactly where it was,
// under one key, for every workspace. `deviceScopedKeys` names it so that a
// reader can see the choice rather than infer it from an absence.
//
// PURE, and that is why it is its own file: `ports/credentials.ts` and
// `identity/store.ts` both reach SecureStore and cannot be loaded under Node,
// while what has to be true — that two workspaces never collide and that
// `local` never moves — is arithmetic on strings.

import { WORKSPACE_LOCAL, isWorkspaceId } from '@lark/core/portable';

/** D16: the identity this install has finished claiming, per library. */
export const COMMITTED_KEY = 'lark.install_id';
/** D16: an identity it was in the middle of claiming, per library. */
export const INTENT_KEY = 'lark.install_intent';
/** The skybridge session, per library. */
export const CREDENTIALS_KEY = 'lark.skybridge';
/** Where `stash()` parks the session across a failed unbind, per library. */
export const CREDENTIALS_STASH_KEY = 'lark.skybridge.stash';

/** Every key that describes ONE workspace, unscoped. */
export const WORKSPACE_SCOPED_KEYS = [
  COMMITTED_KEY,
  INTENT_KEY,
  CREDENTIALS_KEY,
  CREDENTIALS_STASH_KEY,
] as const;

/**
 * The LLM key, named here so its absence from the list above is a decision.
 *
 * It belongs to the device (§4), it is a secret so it cannot join
 * `device.json`, and every workspace on this phone talks to the same model.
 */
export const DEVICE_SCOPED_KEYS = ['lark.llm.api_key'] as const;

/**
 * `base` for `local`, `base.<id>` for an account workspace.
 *
 * A dot, matching what SecureStore keys already look like here, and the id is
 * 32 hex — so no scoped key can ever collide with an unscoped one, whatever
 * base names get added later.
 */
export function workspaceKey(base: string, workspaceId: string): string {
  if (!isWorkspaceId(workspaceId)) throw new Error(`not a workspace id: ${workspaceId}`);
  return workspaceId === WORKSPACE_LOCAL ? base : `${base}.${workspaceId}`;
}

/**
 * Everything one workspace holds in SecureStore.
 *
 * For the one caller that has to erase a workspace rather than a value:
 * deleting a workspace, which is not in N7 (§6) but which this list is the
 * shape of when it arrives.
 */
export function workspaceKeys(workspaceId: string): string[] {
  return WORKSPACE_SCOPED_KEYS.map((base) => workspaceKey(base, workspaceId));
}
