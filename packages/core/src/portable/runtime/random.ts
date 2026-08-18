// Randomness, as a provider (N1a, decision b).
//
// Two consumers, both load bearing: every entity id in the library is a UUID
// v4 (R10), and bilibili's anonymous buvid3 is 16 random bytes. On Node ≥19
// `globalThis.crypto` carries both, so the desktop installs nothing. React
// Native carries NEITHER — `globalThis.crypto.getRandomValues` does not exist
// there (N0b-3, measured), which is exactly why `wbi.ts` copied over verbatim
// would have thrown on the first search.
//
// Resolution happens per call rather than at module load, so "what this host
// has" is answered when it matters and a test can take `globalThis.crypto`
// away and see the refusal.
//
// FAIL-LOUD, never a fallback: a Math.random() UUID would produce ids that
// collide across devices, and sync gives every one of those collisions a
// second library to corrupt.

export interface RandomSource {
  /** A lowercase UUID v4. */
  uuid(): string;
  /** `count` cryptographically random bytes. */
  bytes(count: number): Uint8Array;
}

let installed: RandomSource | null = null;

/**
 * Install this host's randomness.
 *
 * Idempotent for the same object so two bootstraps cannot fight; a DIFFERENT
 * implementation is a refusal, because it means two parts of one process
 * disagree about where ids come from and the loser would be whoever ran second.
 */
export function installRandom(source: RandomSource): void {
  if (installed !== null && installed !== source) {
    throw new Error(
      'a different RandomSource is already installed — one process, one source of ids',
    );
  }
  installed = source;
}

/** Test seam: forget the installed source. */
export function resetRandomForTesting(): void {
  installed = null;
}

interface WebCryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

function webCrypto(): WebCryptoLike | null {
  const candidate = (globalThis as { crypto?: WebCryptoLike }).crypto;
  return typeof candidate === 'object' && candidate !== null ? candidate : null;
}

function missing(what: string): Error {
  return new Error(
    `no RandomSource: this host has no crypto.${what}. Call installRandom() during bootstrap.`,
  );
}

export function uuid(): string {
  if (installed !== null) return installed.uuid();
  const generate = webCrypto()?.randomUUID;
  if (typeof generate !== 'function') throw missing('randomUUID');
  return generate.call(webCrypto());
}

export function randomBytes(count: number): Uint8Array {
  if (installed !== null) return installed.bytes(count);
  const fill = webCrypto()?.getRandomValues;
  if (typeof fill !== 'function') throw missing('getRandomValues');
  return fill.call(webCrypto(), new Uint8Array(count));
}
