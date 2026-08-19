// What this host installs into `@lark/core/portable` before core runs
// (§2.2 step ①).
//
// One thing, and it is the one N0b-3 measured as missing: React Native has no
// `crypto.getRandomValues` and no `crypto.randomUUID`. Every entity id in the
// library is a UUID v4, `wbi.ts`'s buvid fallback needs random bytes, and
// `ensureDeviceUuid` mints this install's local identity — so core's Random
// provider refuses to guess and asks the host. This is the host answering.
//
// FIRST, before anything else in the boot sequence. Not "early": the very
// first thing core does that needs an id throws without it, and on the fresh
// path that is `ensureDeviceUuid` at step ⑨ — after the database has already
// been created and migrated.
//
// Idempotent by construction: the same source object every time, so a second
// call (or a Fast Refresh) is a no-op rather than the "one process, one source
// of ids" refusal.
//
// NO LOCAL `installed` FLAG, and that is a correction rather than an omission.
// There was one, and it cached a fact this module does not own: after
// `resetRandomForTesting()` the port had no source while the flag still said
// "done", so the reinstall was skipped and every later id threw. MEASURED —
// criterion 11's case failed on exactly that. `installRandom` already answers
// the question idempotently; asking it every time is both shorter and the only
// version that cannot go stale.

import { installRandom } from '@lark/core/portable';
import { getRandomValues, randomUUID } from 'expo-crypto';

const source = {
  uuid: (): string => randomUUID(),
  bytes: (count: number): Uint8Array => getRandomValues(new Uint8Array(count)),
};

/** Safe to call from anywhere, any number of times. */
export function installPortableRuntime(): void {
  installRandom(source);
}
