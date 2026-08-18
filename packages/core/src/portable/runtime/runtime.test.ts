// The four runtime ports, each measured against the implementation it
// replaces (N1a, criteria 3/4/5).
//
// The reference is computed HERE, at test time, from `node:crypto` and
// `Buffer` — not copied in as a constant. A hard-coded expectation would keep
// agreeing with itself after Node changed underneath it, and the whole point
// of these ports is that two hosts produce the same bytes.

import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installNodeRuntime } from '../../node-runtime.js';
import { base64ToBytes } from './base64.js';
import {
  installSha256BytesAsync,
  md5Hex,
  resetSha256BytesAsyncForTesting,
  sha256BytesAsync,
  sha256Hex,
} from './digest.js';
import { installRandom, randomBytes, resetRandomForTesting, uuid } from './random.js';
import { decodeUtf8, utf8ByteLength } from './text.js';

/** The N0b-3 sample set: sizes core actually meets, plus the documented cap. */
const DIGEST_SAMPLES = [
  '',
  'wts=1712345678',
  '床前明月光，疑是地上霜。',
  '[00:01.00]歌词一行\n[00:02.50]再一行\n',
  'x'.repeat(5_700), // a real LRC, per the N0b-3 measurement
];

describe('digest', () => {
  it.each(DIGEST_SAMPLES)('md5 matches node:crypto (%#)', (sample) => {
    expect(md5Hex(sample)).toBe(createHash('md5').update(sample, 'utf8').digest('hex'));
  });

  it.each(DIGEST_SAMPLES)('sha256 matches node:crypto (%#)', (sample) => {
    expect(sha256Hex(sample)).toBe(createHash('sha256').update(sample, 'utf8').digest('hex'));
  });

  it('hashes the 256KB inline cap the same way', () => {
    // `SYNC_FILE_OP_INLINE_MAX`. Measured at 86.81ms on the device — the
    // documented worst case, not the common one, which is why the inline
    // digest is allowed to stay synchronous.
    const big = '歌'.repeat(64 * 1024);
    expect(sha256Hex(big)).toBe(createHash('sha256').update(big, 'utf8').digest('hex'));
  });

  describe('whole-file sha256', () => {
    afterEach(() => {
      resetSha256BytesAsyncForTesting();
    });

    it('refuses to guess when nothing is installed', () => {
      resetSha256BytesAsyncForTesting();
      expect(() => sha256BytesAsync(new Uint8Array([1, 2, 3]))).toThrow(/no sha256BytesAsync/);
    });

    it('matches node:crypto once the desktop installs it', async () => {
      installNodeRuntime();
      const bytes = new Uint8Array(Buffer.from('导出的歌单', 'utf8'));
      expect(await sha256BytesAsync(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    });

    it('is idempotent for the same implementation and loud about a different one', () => {
      installNodeRuntime();
      expect(() => installNodeRuntime()).not.toThrow();
      expect(() => installSha256BytesAsync(async () => 'nope')).toThrow(/already installed/);
    });
  });
});

describe('random', () => {
  afterEach(() => {
    resetRandomForTesting();
    vi.unstubAllGlobals();
  });

  it('needs no install on Node', () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(randomBytes(16)).toHaveLength(16);
    expect(randomBytes(16)).not.toEqual(randomBytes(16));
  });

  it('refuses on a host that has neither (React Native, measured N0b-3)', () => {
    vi.stubGlobal('crypto', {});
    expect(() => uuid()).toThrow(/crypto\.randomUUID/);
    expect(() => randomBytes(16)).toThrow(/crypto\.getRandomValues/);
  });

  it('uses what a host installs, idempotently, and refuses a second opinion', () => {
    const source = { uuid: () => 'installed-id', bytes: (n: number) => new Uint8Array(n).fill(7) };
    installRandom(source);
    installRandom(source); // same object: a no-op, not a fight
    expect(uuid()).toBe('installed-id');
    expect(randomBytes(3)).toEqual(new Uint8Array([7, 7, 7]));
    expect(() => installRandom({ uuid: randomUUID, bytes: (n) => new Uint8Array(n) })).toThrow(
      /already installed/,
    );
  });
});

describe('text', () => {
  // Six shapes, including the one that has no valid encoding at all.
  const TEXTS = [
    'plain ascii',
    '床前明月光',
    '歌曲 🎵 done',
    'é à ñ',
    'before\uD83Dafter', // lone surrogate
    JSON.stringify({ name: '歌曲 🎵', artist: 'Ärtist' }),
  ];

  it.each(TEXTS)('utf8ByteLength matches Buffer.byteLength (%#)', (text) => {
    expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
  });

  // Four decode fixtures per criterion 5, plus the BOM — which is the one that
  // caught a real behaviour change: TextDecoder STRIPS a leading U+FEFF by
  // default and `Buffer.toString('utf8')` keeps it, and the caller downstream
  // is `JSON.parse`, which refuses a kept BOM. Defaulting would have silently
  // started accepting BOM'd import files.
  const DECODES: [string, Uint8Array][] = [
    ['chinese', new Uint8Array(Buffer.from('床前明月光', 'utf8'))],
    ['emoji', new Uint8Array(Buffer.from('歌曲 🎵 done', 'utf8'))],
    ['truncated multi-byte', new Uint8Array(Buffer.from('床前明月光', 'utf8').subarray(0, 7))],
    ['invalid utf-8', new Uint8Array([0x41, 0xff, 0xfe, 0x42, 0x80])],
    [
      'bom',
      new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')])),
    ],
  ];

  it.each(DECODES)('decodeUtf8 matches Buffer.toString for %s', (_label, bytes) => {
    expect(decodeUtf8(bytes)).toBe(Buffer.from(bytes).toString('utf8'));
  });

  it('keeps the BOM, so JSON.parse still refuses a BOM"d file', () => {
    const withBom = decodeUtf8(DECODES[4][1]);
    expect(withBom.charCodeAt(0)).toBe(0xfeff);
    expect(() => JSON.parse(withBom)).toThrow();
  });
});

describe('base64', () => {
  // The seven N0b-3 samples, verbatim: two of them are where `atob` diverges.
  const SAMPLES: [string, string][] = [
    ['padded', Buffer.from('床前明月光', 'utf-8').toString('base64')],
    ['unpadded', Buffer.from('床前明月光', 'utf-8').toString('base64').replace(/=+$/, '')],
    [
      'newlines inside',
      Buffer.from('lyrics line', 'utf-8')
        .toString('base64')
        .replace(/^(.{4})/, '$1\n'),
    ],
    ['illegal character', 'aGVs!bG8='],
    ['url-safe alphabet', Buffer.from([0xfb, 0xff, 0xbf]).toString('base64url')],
    ['length 1 mod 4', 'aGVsbG8X'],
    ['empty', ''],
  ];

  it.each(SAMPLES)('decodes %s exactly like Buffer.from', (_label, input) => {
    expect(Buffer.from(base64ToBytes(input))).toEqual(Buffer.from(input, 'base64'));
  });

  it('stops at the first padding, mid-string included', () => {
    // Not cosmetic: skipping `=` instead of stopping decodes the trailing junk
    // into bytes Buffer never produced.
    expect(Buffer.from(base64ToBytes('aGVsbG8=d29ybGQ='))).toEqual(
      Buffer.from('aGVsbG8=d29ybGQ=', 'base64'),
    );
  });
});
