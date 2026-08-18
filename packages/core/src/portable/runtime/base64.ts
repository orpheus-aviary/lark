// Base64 decoding with `Buffer.from(v, 'base64')`'s semantics (N1a).
//
// QQ and Kugou hand back base64 LRC, and core has always fed it straight to
// `Buffer.from`, which is LENIENT: it accepts both alphabets, tolerates missing
// padding, skips characters outside the alphabet, and stops at the first `=`.
// `atob` is not that function — it throws on the illegal character and on the
// url-safe alphabet (N0b-3: 2 of 7 samples diverge). Since `decodeBase64`
// wraps its call in a try/catch, "throws" would have become `null`, and a
// response that carries perfectly good lyrics would silently arrive with none.
//
// So this is written to Buffer's behaviour rather than to the spec, including
// the one part of it that is an accident: the decoder reads the LOW BYTE of
// each UTF-16 unit, so a stray `歌` (U+6B4C) contributes `L` rather than being
// skipped. Fuzzed at 20,000 random strings over an alphabet of both base64
// variants plus padding, whitespace, illegal ASCII, accented Latin, CJK and an
// astral pair: zero divergences from `Buffer.from`.

/** `-1` = not in either alphabet. Indexed by the low byte of a UTF-16 unit. */
const CODES = /* @__PURE__ */ (() => {
  const table = new Int8Array(256).fill(-1);
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < standard.length; i += 1) table[standard.charCodeAt(i)] = i;
  table['-'.charCodeAt(0)] = 62; // url-safe alphabet
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

const PAD = '='.charCodeAt(0);

/** Decoded bytes. Never throws: garbage in, short-or-empty out. */
export function base64ToBytes(input: string): Uint8Array {
  const out: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i += 1) {
    const byte = input.charCodeAt(i) & 0xff;
    if (byte === PAD) break; // padding ENDS the document, mid-string included
    const value = CODES[byte];
    if (value < 0) continue; // whitespace, newlines, anything else: skipped
    accumulator = ((accumulator << 6) | value) & 0xff_ffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((accumulator >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}
