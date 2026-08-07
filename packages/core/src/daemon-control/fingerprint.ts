// Nest identity as a public, token-free fingerprint (M6-19).
//
// `GET /status` is the only unauthenticated route, and before M6 it proved
// liveness but nothing about WHO answered: `/api/instance` carries the data
// directory, but reading it needs the token of the nest that published it — so
// a daemon belonging to a different nest was indistinguishable from an
// unreachable one. Every caller then had to fail closed on a port that was, in
// fact, perfectly explicable.
//
// The fingerprint closes that gap without publishing the path. What it leaks is
// path EQUALITY (and it is guessable by dictionary — home directories are not
// secrets), which is accepted on a 127.0.0.1 socket behind the Host whitelist.
//
// ONE implementation, shared by the daemon that publishes it and every client
// that compares it: two "obviously identical" hashes of a path drift the moment
// one side trims a trailing slash. The fixed vectors in the test file exist to
// make any encoding change loud.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * SHA-256 (64 lowercase hex) of a resolved lark data directory.
 *
 * Takes the path as a STRING and hashes it verbatim: resolution is the
 * caller's job (`realpathMissingOk`), so a comparison can never accidentally
 * hash one side's raw path against the other's resolved one.
 */
export function nestFingerprint(realLarkDir: string): string {
  return createHash('sha256').update(realLarkDir, 'utf8').digest('hex');
}

/** 64 lowercase hex characters — the only shape `nestFingerprint` produces. */
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

export function isNestFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_RE.test(value);
}

/**
 * `realpath()` that tolerates a path which does not exist yet.
 *
 * A CLI write against a fresh nest computes its own fingerprint BEFORE the
 * directory is created, while the daemon computes it after — so a plain
 * `realpathSync` would either throw or produce a different string for the same
 * location. Resolving the longest existing ancestor and re-appending the rest
 * gives both sides the same answer: once the daemon creates the directory,
 * `realpath` of it IS `realpath(ancestor)/rest`.
 *
 * Only ENOENT is tolerated. A permission error on an ancestor is a real
 * problem and propagates.
 */
export function realpathMissingOk(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : [real, ...missing].join(sep);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const parent = resolve(current, '..');
    // Root reached without resolving anything: nothing left to strip, so the
    // normalised absolute path is the best answer available.
    if (parent === current) return absolute;
    missing.unshift(current.slice(parent === sep ? parent.length : parent.length + 1));
    current = parent;
  }
}
