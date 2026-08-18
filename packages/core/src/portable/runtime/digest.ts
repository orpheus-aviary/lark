// Hashing, split three ways by INPUT SIZE (N1a, decision a).
//
// N0b-3 measured all three on the frozen device (release build):
//
//   - md5 over a WBI query: 0.02ms with `@noble/hashes`, an order of magnitude
//     faster than the async native call — and every signed request pays it.
//   - sha256 over inline lyrics: 1.94ms for a real 5.7KB LRC. The 256KB cap
//     (`SYNC_FILE_OP_INLINE_MAX`) costs 86.81ms, which is the documented worst
//     case, not the common one.
//   - sha256 over a whole import file (up to 20MB): pure JS is not an option,
//     so the host provides it.
//
// The first two are SYNCHRONOUS because their callers are: `signWbiParams` is
// pure, and the inline digest runs inside a transaction, where an await would
// mean holding a write lock across the event loop.

import { md5 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** Hex md5 of a short string — WBI signing, and nothing else. */
export function md5Hex(text: string): string {
  return bytesToHex(md5(utf8ToBytes(text)));
}

/** Hex sha256 of a bounded string (inline lyrics; see the cap above). */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

type Sha256BytesAsync = (data: Uint8Array) => Promise<string>;

let installedSha256Bytes: Sha256BytesAsync | null = null;

/**
 * Install the host's sha256 over arbitrary bytes.
 *
 * Same idempotence rule as the random source: re-installing the same function
 * is a no-op, a different one is a refusal.
 */
export function installSha256BytesAsync(impl: Sha256BytesAsync): void {
  if (installedSha256Bytes !== null && installedSha256Bytes !== impl) {
    throw new Error('a different sha256BytesAsync is already installed');
  }
  installedSha256Bytes = impl;
}

/** Test seam: forget the installed implementation. */
export function resetSha256BytesAsyncForTesting(): void {
  installedSha256Bytes = null;
}

/**
 * Hex sha256 of whole-file bytes.
 *
 * NO default. An async signature is not the same thing as a non-blocking one —
 * a Promise wrapped around the synchronous `sha256` above would still hash
 * 20MB on the JS thread, and the caller could not tell. So a host that has not
 * installed a real implementation is told so, loudly, instead of shipping a
 * frozen UI. The desktop installs `node:crypto` through the core barrel; the
 * mobile client must install one before playlist transfer opens up (N6), and
 * this refusal is that gate.
 */
export function sha256BytesAsync(data: Uint8Array): Promise<string> {
  if (installedSha256Bytes === null) {
    throw new Error(
      'no sha256BytesAsync installed — this host must provide a non-blocking whole-file digest',
    );
  }
  return installedSha256Bytes(data);
}
