// What the desktop installs into `portable/runtime` (N1a).
//
// Only one thing, and only because the portable side refuses to guess: a
// non-blocking sha256 over whole-file bytes. Randomness needs no install here —
// Node ≥19 carries `globalThis.crypto`, which is exactly the surface the
// provider falls back to.
//
// Called from the core barrel, which is how every desktop consumer arrives:
// the daemon imports `@lark/core`, the CLI's `--direct` backend imports it
// dynamically, and core's own tests that exercise an installed path call this
// themselves. A component that imports a deep path and hashes a 20MB file
// without going through either is a component that would fail on a phone too —
// the refusal is the point.

import { createHash } from 'node:crypto';
import { installSha256BytesAsync } from './portable/runtime/digest.js';

/** Idempotent: the same function object every time, so re-entry is a no-op. */
const sha256BytesNode = (data: Uint8Array): Promise<string> =>
  Promise.resolve(createHash('sha256').update(data).digest('hex'));

export function installNodeRuntime(): void {
  installSha256BytesAsync(sha256BytesNode);
}
