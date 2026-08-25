// What this host installs into `@lark/core/portable` before core runs
// (§2.2 step ①).
//
// TWO things, and core refuses to guess at either of them.
//
// ① RANDOM (N0b-3 measured it missing): React Native has no
// `crypto.getRandomValues` and no `crypto.randomUUID`. Every entity id in the
// library is a UUID v4, `wbi.ts`'s buvid fallback needs random bytes, and
// `ensureDeviceUuid` mints this install's local identity — so core's Random
// provider asks the host. This is the host answering.
//
// ② A NON-BLOCKING WHOLE-FILE SHA-256 (N6a). `runtime/digest.ts` splits
// hashing by input size and leaves the biggest split with NO DEFAULT on
// purpose: an import file is up to 20MB, and a Promise wrapped around the
// synchronous hash would still freeze the JS thread while the caller believed
// it had gone away. `expo-crypto`'s `digest` is a real native async call,
// which is the shape that refusal has been waiting for since N1a. Playlist
// import is its only caller, which is why the phone got this far without one.
//
// FIRST, before anything else in the boot sequence. Not "early": the very
// first thing core does that needs an id throws without it, and on the fresh
// path that is `ensureDeviceUuid` at step ⑨ — after the database has already
// been created and migrated.
//
// Idempotent by construction: the same objects every time, so a second call
// (or a Fast Refresh) is a no-op rather than the "one process, one source of
// ids" refusal. Both installers refuse a DIFFERENT function, so neither of
// these may become a lambda at the call site.
//
// NO LOCAL `installed` FLAG, and that is a correction rather than an omission.
// There was one, and it cached a fact this module does not own: after
// `resetRandomForTesting()` the port had no source while the flag still said
// "done", so the reinstall was skipped and every later id threw. MEASURED —
// criterion 11's case failed on exactly that. `installRandom` already answers
// the question idempotently; asking it every time is both shorter and the only
// version that cannot go stale.

import { installRandom, installSha256BytesAsync } from '@lark/core/portable';
import { bytesToHex } from '@noble/hashes/utils.js';
import { CryptoDigestAlgorithm, digest, getRandomValues, randomUUID } from 'expo-crypto';

const source = {
  uuid: (): string => randomUUID(),
  bytes: (count: number): Uint8Array => getRandomValues(new Uint8Array(count)),
};

/**
 * `digest` takes a view over a plain `ArrayBuffer`, and a `Uint8Array` is only
 * known to be over an `ArrayBufferLike` — which includes `SharedArrayBuffer`.
 *
 * A guard rather than a cast, and rather than an unconditional copy: Hermes
 * has no `SharedArrayBuffer`, so the true branch is the only one this app
 * takes and it hands the bytes over as they are. The copy is what a runtime
 * that grew one would get, which is a better answer than an assertion that
 * would be wrong there.
 */
function overArrayBuffer(view: Uint8Array): view is Uint8Array<ArrayBuffer> {
  return view.buffer instanceof ArrayBuffer;
}

/** Hex, because that is what the wire and the file both carry (`ParsedImportFile.digest`). */
const sha256Bytes = async (data: Uint8Array): Promise<string> => {
  const bytes = overArrayBuffer(data) ? data : new Uint8Array(data);
  return bytesToHex(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)));
};

/** Safe to call from anywhere, any number of times. */
export function installPortableRuntime(): void {
  installRandom(source);
  installSha256BytesAsync(sha256Bytes);
}
