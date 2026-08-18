// The four things portable code needs from its host's runtime (N1a).
//
// Two of them are static — the same code everywhere (digest of small inputs,
// text and base64 helpers) — and two are installed by whoever boots the
// process: randomness, and a non-blocking whole-file digest. The split is
// decision a/b of the N1 subplan, and it is by MEASUREMENT, not by taste:
// see the file comments for the numbers each one rests on.

export * from './base64.js';
export * from './digest.js';
export * from './random.js';
export * from './text.js';
