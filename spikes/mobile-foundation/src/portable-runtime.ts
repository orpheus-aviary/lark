// What this host installs into `@lark/core/portable` before core runs (N1).
//
// One thing, and it is the one N0b-3 measured as missing: React Native has no
// `crypto.getRandomValues` and no `crypto.randomUUID`. `wbi.ts`'s buvid
// fallback and every entity id in the library go through them, so core's
// Random provider refuses to guess and asks the host — this is the host
// answering. Importing this module is what makes the download client usable
// here at all; without it R1's first call throws.
//
// Idempotent by construction: the same source object every time, so a second
// import (or a panel that re-runs) is a no-op rather than a fight.

import { installRandom } from '@lark/core/portable';
import { getRandomValues, randomUUID } from 'expo-crypto';

const source = {
  uuid: (): string => randomUUID(),
  bytes: (count: number): Uint8Array => getRandomValues(new Uint8Array(count)),
};

let installed = false;

/** Safe to call from anywhere; the first call wins and the rest are no-ops. */
export function installPortableRuntime(): void {
  if (installed) return;
  installRandom(source);
  installed = true;
}
