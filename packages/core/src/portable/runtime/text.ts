// UTF-8 length and decoding, without `Buffer` (N1a, decision o).
//
// Both are ambient on the desktop and absent on a phone, and both are load
// bearing: the byte length decides whether a change is small enough to push
// (§3.9), and the decode is how an import file becomes text.
//
// `TextEncoder` is native on the measurement device and agreed with
// `Buffer.byteLength` on all six N0b samples, lone surrogate included;
// `TextDecoder` is a polyfill there and round-tripped a multi-byte sequence
// split across chunks (N0b §9).

const encoder = new TextEncoder();

/**
 * Bytes this string occupies as UTF-8 — what `Buffer.byteLength(s, 'utf8')`
 * answered. Unpaired surrogates encode as U+FFFD (3 bytes) on both.
 */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Bytes → string, replacing malformed sequences rather than throwing.
 *
 * `ignoreBOM: true` is the load-bearing option and it is named backwards: it
 * means "leave a leading U+FEFF in the output", which is what
 * `Buffer.toString('utf8')` does. The default STRIPS it — and a stripped BOM
 * is not a cosmetic difference here, because the one caller feeds the result
 * to `JSON.parse`, which refuses a leading U+FEFF. Defaulting would silently
 * start accepting BOM'd import files, i.e. a behaviour change smuggled in by a
 * decoder option (measured, N1a).
 *
 * Non-fatal on purpose, also matching Buffer: a truncated multi-byte tail
 * becomes U+FFFD and the caller's own validation reports the problem in terms
 * of the file, not in terms of an encoding exception.
 */
const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: false });

export function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
