// Which library is this, and what is it called on disk (N7b).
//
// A WORKSPACE is one library plus everything that belongs to it: its
// `songs.db`, its `songs/`, and — on the desktop — its skybridge credentials.
// Until N7 a device had exactly one, so it had no name; now it has several and
// each needs one that survives a reinstall, a URL change and a logout.
//
// THE DEFINITION IS OWL'S, DELIBERATELY (`../owl/packages/core/src/profile/
// id.ts`, D11), down to the byte: `sha256(serverId + "\n" + userId)`, first 32
// hex. `workspace.test.ts` pins it against fixtures generated from owl's own
// build, because "the same rule" is a claim that decays unless something
// checks it.
//
// WHY A HASH AND NOT A RANDOM ID: it is DETERMINISTIC, so logging into the
// same account always lands on the same local copy. Log out, log back in, and
// there is one workspace rather than two — which is the whole feature.
//
// WHY server_id AND NOT THE URL: the anchor is the long random identity the
// skybridge server mints for itself (0.1.4 `login` / `/server-info`), so
// moving the deployment or putting it behind a different name keeps the same
// workspace. lark has a standing account for this — the TLS work will change
// the URL one day, and it must not orphan anybody's library.
//
// 🔒 32 HEX IS FROZEN once any workspace exists on disk: the id IS a directory
// name and the value of `active` in the index. Widening it would orphan every
// directory already there.
//
// WHERE THE HASH COMES FROM. `sha256Hex` in `runtime/digest.ts` — pure JS
// (`@noble/hashes`), no install required, identical on both hosts. That is
// also why this module is here and not in `@lark/shared`: a workspace id never
// crosses the wire (the server knows nothing about workspaces; this is a local
// storage decision), and `shared` has no digest.

import { sha256Hex } from './runtime/digest.js';

/**
 * The workspace of a device that has never logged in — and of the library
 * that was already there when this feature arrived.
 *
 * Reserved: it is the one id that is not a hash, and the one whose files sit
 * at the root of the nest rather than under `libraries/`. That is what makes
 * "zero migration" true on the phone (§2.4) — an existing library simply
 * becomes `local`, in place, including one that had already been bound to an
 * account.
 */
export const WORKSPACE_LOCAL = 'local';

const WORKSPACE_ID_RE = /^[0-9a-f]{32}$/;

/** True only for an account workspace — rejects `local` and anything else. */
export function isAccountWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_RE.test(id);
}

/** Every id this build will open a library for: `local`, or 32 lowercase hex. */
export function isWorkspaceId(id: string): boolean {
  return id === WORKSPACE_LOCAL || isAccountWorkspaceId(id);
}

/** The directory account workspaces live under, inside a nest. */
export const LIBRARIES_DIRECTORY = 'libraries';

/**
 * Where a workspace sits, relative to the nest — the LAYOUT, in one place.
 *
 * Empty for `local`, which is what "in place, nothing moved" means and the
 * whole of the zero-migration story (§2.4). `['libraries', id]` otherwise.
 *
 * Both hosts join these onto their own idea of a directory — `node:path` on
 * the desktop, expo's `Directory` on the phone — so the one thing that must
 * not differ is which segments there are. A phone that put its workspaces
 * somewhere else would still isolate them, but a nest copied between the two
 * would stop being one thing.
 *
 * The id gate runs before the segments exist, not after: this value becomes a
 * real path, and the id can arrive from a file somebody edited.
 */
export function workspaceSegments(id: string): readonly string[] {
  if (!isWorkspaceId(id)) throw new Error(`not a workspace id: ${id}`);
  return id === WORKSPACE_LOCAL ? [] : [LIBRARIES_DIRECTORY, id];
}

/**
 * The workspace an account lives in on this device.
 *
 * Both arguments are opaque server-issued ids and are used VERBATIM — no
 * trimming, no case folding, no url parsing. The server owns their canonical
 * form, and normalising here would be this client inventing a second one.
 *
 * It refuses empty input rather than hashing it. An empty `server_id` or
 * `user_id` is not an account this device has ever talked to; it is a login
 * response that was missing a field, and turning that into a valid-looking
 * directory name is how two different accidents come to share a library. (owl
 * hashes them, because nothing there can reach it with an empty one either —
 * the difference is a refusal, not a different id.)
 */
export function computeWorkspaceId(serverId: string, userId: string): string {
  if (serverId === '' || userId === '') {
    throw new Error('a workspace id needs both a server_id and a user_id');
  }
  return sha256Hex(`${serverId}\n${userId}`).slice(0, 32);
}
