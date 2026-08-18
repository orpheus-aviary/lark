// WBI request signing + the anonymous-identity cookies (M3-3).
//
// Why this exists at all: on 2026-08-04 the Go version's plain
// `x/web-interface/search/type` call started answering HTTP 200 with a risk
// control HTML page. The deterministic endpoints (pagelist / view / playurl /
// fav / collection) are still open, so ONLY keyword search goes through here —
// signing everything would be cargo cult.
//
// Two independent pieces of plumbing:
//
//   - WBI: `nav` hands out an img/sub key pair (no login needed), they get
//     scrambled through a fixed permutation table into a mixin key, and every
//     signed request carries `wts` + an MD5 `w_rid` over its sorted params.
//   - buvid: `spi` issues a b_3/b_4 pair that identifies the anonymous client.
//     The Go version made these up locally; a real pair is one fewer signal
//     for risk control to flag.
//
// The signing half is pure and covered by a fixed vector; only the two key
// fetches touch the network.

import { BilibiliApiError } from '../errors.js';
import { md5Hex } from '../runtime/digest.js';
import { randomBytes } from '../runtime/random.js';

/** bilibili's fixed permutation of the 64-char img+sub concatenation. */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export interface WbiKeys {
  imgKey: string;
  subKey: string;
}

/** Scramble img+sub into the 32-char key the signature is salted with. */
export function getMixinKey(imgKey: string, subKey: string): string {
  const orig = imgKey + subKey;
  let out = '';
  for (const idx of MIXIN_KEY_ENC_TAB) {
    if (idx < orig.length) out += orig[idx];
  }
  return out.slice(0, 32);
}

/**
 * Sign a parameter set: sort by key, URL-encode with `!'()*` stripped from
 * VALUES (bilibili's own client does this, and the server re-derives the hash
 * the same way), MD5 the whole query plus the mixin key.
 *
 * `wts` is supplied rather than read from the clock so the vector test can pin
 * a known-good signature.
 */
export function signWbiParams(
  params: Record<string, string | number>,
  keys: WbiKeys,
  wts: number,
): string {
  const withTs: Record<string, string | number> = { ...params, wts };
  const query = Object.keys(withTs)
    .sort()
    .map((k) => {
      const value = String(withTs[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  const wRid = md5Hex(query + getMixinKey(keys.imgKey, keys.subKey));
  return `${query}&w_rid=${wRid}`;
}

// ─── Key / identity fetches ────────────────────────────

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi';

/** `https://i0.hdslb.com/bfs/wbi/<key>.png` → `<key>`. */
function keyFromUrl(url: string): string {
  const file = url.split('/').pop() ?? '';
  const dot = file.lastIndexOf('.');
  return dot === -1 ? file : file.slice(0, dot);
}

/**
 * Fetch the WBI key pair.
 *
 * Anonymously, `nav` answers envelope code **-101 (not logged in)** and STILL
 * carries `wbi_img` — so the code is deliberately not checked. Reading it as a
 * failure is the obvious mistake here, and it fails closed on a working setup.
 */
export async function fetchWbiKeys(
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<WbiKeys> {
  const response = await fetchImpl(NAV_URL, { headers, signal });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BilibiliApiError(`nav returned non-JSON: ${text.slice(0, 120)}`);
  }
  const wbi = (body as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } })?.data
    ?.wbi_img;
  const imgKey = keyFromUrl(wbi?.img_url ?? '');
  const subKey = keyFromUrl(wbi?.sub_url ?? '');
  if (imgKey === '' || subKey === '') {
    throw new BilibiliApiError('nav response carried no wbi_img keys');
  }
  return { imgKey, subKey };
}

export interface Buvid {
  buvid3: string;
  buvid4: string;
}

/**
 * Ask spi for an anonymous identity pair. Falls back to a locally generated
 * buvid3 (the Go version's approach) rather than failing: a made-up cookie
 * still works for the unsigned endpoints, and losing search is better than
 * losing every download.
 */
export async function fetchBuvid(
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Buvid> {
  try {
    const response = await fetchImpl(SPI_URL, { headers, signal });
    const body = (await response.json()) as {
      code?: number;
      data?: { b_3?: string; b_4?: string };
    };
    if (body.code === 0 && typeof body.data?.b_3 === 'string' && body.data.b_3 !== '') {
      return { buvid3: body.data.b_3, buvid4: body.data.b_4 ?? '' };
    }
  } catch {
    // fall through to the local fallback
  }
  return { buvid3: randomBuvid3(), buvid4: '' };
}

/** The Go version's shape: 16 random bytes as uppercase hex, then `infoc`. */
export function randomBuvid3(): string {
  const bytes = randomBytes(16);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return `${hex}infoc`;
}
