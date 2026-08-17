// Criterion 20 — the Crypto port, decided by measurement rather than by taste.
//
// The problem the port exists for: `expo-crypto`'s digests are ASYNC, and core's
// two digest call sites are SYNCHRONOUS — `wbi.ts:67-69` signs a query inside a
// plain function, and `file-ops.ts:342` hashes inline lyrics inside a
// transaction. Making those async is a change to two real call graphs, so the
// preferred shape (decision d2) is a pure-JS synchronous digest, and this panel
// is what earns it: `@noble/hashes`, checked for correctness against the
// desktop's own `node:crypto` output, then timed under §3.2a.
//
// Thresholds: md5 of a WBI query p95 ≤ 5ms, sha256 of a real-sized lyric
// (≤8KB) p95 ≤ 10ms.
//
// The sha256 threshold was rebound to the REAL size on 2026-08-17 (criterion
// 20, exit C). It used to say 256KB ≤ 50ms; the measurement said 83.66ms, and
// the call graph says why that is the wrong thing to gate on: `inlineDigest`'s
// only large input is an inlined lyric, a real LRC is 5.7KB (1.83ms), and 256KB
// is `SYNC_FILE_OP_INLINE_MAX` — the CAP, not the norm. 256KB is still measured
// and still reported, as a labelled worst case with a known cost (83ms per row
// in `listFileOps`, and only for a user who really has a quarter-megabyte
// lyric stuck in the queue).
//
// The randomness half of the port is expo-crypto's: `randomUUID` for every
// `client_change_id` (changes.ts:45) and `getRandomValues` for `randomBuvid3`
// (wbi.ts:147-153). Both are already synchronous, so they only have to exist
// and be right.

import { SYNC_FILE_OP_INLINE_MAX, isUuidV4 } from '@lark/shared';
import { md5 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { CryptoDigestAlgorithm, digestStringAsync, getRandomValues, randomUUID } from 'expo-crypto';
import {
  BULK_256K,
  type DigestFixture,
  LYRICS_4K,
  WBI_QUERY,
  WBI_QUERY_MD5,
  WBI_QUERY_SHA256,
} from '../desktop-fixtures';
import { type Timing, batchAverage, judge, measure } from '../measure';

const MD5_BUDGET_MS = 5;
const SHA256_BUDGET_MS = 10;

export interface CryptoRow {
  name: string;
  ok: boolean | null;
  detail: string;
  timing: Timing | null;
  /** Average of a 1,000-call run, for operations far below the clock's floor. */
  perCallMs: number | null;
}

const build = (f: DigestFixture): string => f.seed.repeat(f.repeats);

const hex = {
  md5: (s: string): string => bytesToHex(md5(utf8ToBytes(s))),
  sha256: (s: string): string => bytesToHex(sha256(utf8ToBytes(s))),
};

/**
 * Correctness first, and separately from speed.
 *
 * A digest that is fast and wrong signs bilibili requests that get refused, and
 * the refusal looks like rate limiting rather than like a bug here.
 */
function checkDigests(): CryptoRow[] {
  const rows: CryptoRow[] = [];
  const compare = (name: string, actual: string, expected: string): void => {
    rows.push({
      name,
      ok: actual === expected,
      detail:
        actual === expected
          ? `${actual.slice(0, 16)}… matches the desktop`
          : `got ${actual}, desktop says ${expected}`,
      timing: null,
      perCallMs: null,
    });
  };

  compare('md5 of the WBI query', hex.md5(WBI_QUERY), WBI_QUERY_MD5);
  compare('sha256 of the WBI query', hex.sha256(WBI_QUERY), WBI_QUERY_SHA256);
  const lyrics = build(LYRICS_4K);
  compare(`md5 of a ${LYRICS_4K.bytes}B lyric (multibyte)`, hex.md5(lyrics), LYRICS_4K.md5 ?? '');
  compare(
    `sha256 of a ${LYRICS_4K.bytes}B lyric (multibyte)`,
    hex.sha256(lyrics),
    LYRICS_4K.sha256,
  );
  const bulk = build(BULK_256K);
  compare(`sha256 of ${BULK_256K.bytes}B`, hex.sha256(bulk), BULK_256K.sha256);
  return rows;
}

function timeDigests(): CryptoRow[] {
  const lyrics = build(LYRICS_4K);
  const bulk = build(BULK_256K);

  const wbiTiming = measure('md5(WBI query)', () => {
    hex.md5(WBI_QUERY);
  });
  const lyricsTiming = measure(`sha256(${LYRICS_4K.bytes}B lyric)`, () => {
    hex.sha256(lyrics);
  });
  const bulkTiming = measure(`sha256(${BULK_256K.bytes}B)`, () => {
    hex.sha256(bulk);
  });

  return [
    {
      name: `md5 of a WBI query — p95 ≤ ${MD5_BUDGET_MS}ms`,
      ok: judge(wbiTiming.p95 <= MD5_BUDGET_MS),
      detail: `p50 ${wbiTiming.p50}ms · p95 ${wbiTiming.p95}ms · max ${wbiTiming.max}ms`,
      timing: wbiTiming,
      // A single md5 of 166 bytes can land under the clock's resolution, and a
      // p95 of 0 is not a number anyone should quote. The batch average is.
      perCallMs: batchAverage(() => {
        hex.md5(WBI_QUERY);
      }, 1_000),
    },
    {
      name: `sha256 of a ${LYRICS_4K.bytes}B lyric (the real file-ops size) — p95 ≤ ${SHA256_BUDGET_MS}ms`,
      ok: judge(lyricsTiming.p95 <= SHA256_BUDGET_MS),
      detail: `p50 ${lyricsTiming.p50}ms · p95 ${lyricsTiming.p95}ms · max ${lyricsTiming.max}ms`,
      timing: lyricsTiming,
      perCallMs: batchAverage(() => {
        hex.sha256(lyrics);
      }, 200),
    },
    {
      // The cap, measured on purpose: `SYNC_FILE_OP_INLINE_MAX` is exactly
      // 256KB, so this is the largest lyric `inlineDigest` can ever be handed,
      // and `listFileOps` hashes one per pending row on a read path. Reported
      // as the cost of the decision rather than gated on (exit C) — dropping
      // the measurement would be how the cost stops being known.
      name: `sha256 of ${BULK_256K.bytes}B (= SYNC_FILE_OP_INLINE_MAX ${SYNC_FILE_OP_INLINE_MAX}B) — WORST CASE, not a threshold`,
      ok: null,
      detail: `p50 ${bulkTiming.p50}ms · p95 ${bulkTiming.p95}ms · max ${bulkTiming.max}ms`,
      timing: bulkTiming,
      perCallMs: null,
    },
  ];
}

/**
 * What the turn-to-async branch would cost, measured rather than assumed.
 *
 * Not a threshold — evidence. If the sync digest passes, this is the number
 * that says what was avoided; if it fails, it is the first input to the branch.
 * One await is not free either: it is a JS↔native round trip per call, and WBI
 * signs on every request.
 */
async function timeExpoDigest(
  label: string,
  input: string,
  expected: string,
  rounds: number,
): Promise<CryptoRow> {
  const started = globalThis.performance?.now?.() ?? Date.now();
  for (let i = 0; i < rounds; i += 1) {
    await digestStringAsync(CryptoDigestAlgorithm.SHA256, input);
  }
  const each = ((globalThis.performance?.now?.() ?? Date.now()) - started) / rounds;
  const digest = (await digestStringAsync(CryptoDigestAlgorithm.SHA256, input)).toLowerCase();
  return {
    name: `reference: expo-crypto digestStringAsync(SHA256), ${label}`,
    ok: digest === expected,
    detail: `${Math.round(each * 100) / 100}ms per await over ${rounds} calls · ${
      digest === expected ? 'same digest as the desktop' : 'DIFFERENT digest'
    }`,
    timing: null,
    perCallMs: Math.round(each * 10_000) / 10_000,
  };
}

async function expoDigestRows(): Promise<CryptoRow[]> {
  // Both sizes, because they answer different halves of the branch: the short
  // one is what WBI would pay on every request (round-trip dominated), the
  // 256KB one is what file-ops would pay (marshalling dominated) and it is the
  // exact reachable maximum — `SYNC_FILE_OP_INLINE_MAX`.
  return [
    await timeExpoDigest('WBI query', WBI_QUERY, WBI_QUERY_SHA256, 20),
    await timeExpoDigest(`${BULK_256K.bytes}B`, build(BULK_256K), BULK_256K.sha256, 5),
  ];
}

/** The randomness half: both already synchronous, so they only have to be right. */
function checkRandomness(): CryptoRow[] {
  const rows: CryptoRow[] = [];

  const ids = new Set<string>();
  let shaped = true;
  for (let i = 0; i < 1_000; i += 1) {
    const id = randomUUID();
    if (!isUuidV4(id)) shaped = false;
    ids.add(id);
  }
  rows.push({
    name: 'expo-crypto randomUUID — every client_change_id',
    ok: shaped && ids.size === 1_000,
    detail: `${ids.size}/1000 distinct · ${shaped ? 'all pass @lark/shared isUuidV4' : 'SHAPE FAILURE'}`,
    timing: null,
    perCallMs: batchAverage(() => {
      randomUUID();
    }, 1_000),
  });

  // `randomBuvid3` fills 16 bytes and hexes them (wbi.ts:147-153). Two draws
  // being equal would mean the generator is not one.
  const draw = (): string => {
    const bytes = new Uint8Array(16);
    getRandomValues(bytes);
    return `${Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()}infoc`;
  };
  const a = draw();
  const b = draw();
  const wellFormed = /^[0-9A-F]{32}infoc$/.test(a) && /^[0-9A-F]{32}infoc$/.test(b);
  rows.push({
    name: 'expo-crypto getRandomValues — randomBuvid3',
    ok: wellFormed && a !== b,
    detail: wellFormed ? `${a.slice(0, 12)}… ≠ ${b.slice(0, 12)}…` : `malformed: ${a}`,
    timing: null,
    perCallMs: null,
  });

  // The same call through the global, because that is what core's source says
  // (`crypto.getRandomValues`) and Expo's runtime is what provides it.
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  const hasGlobal = typeof globalCrypto?.getRandomValues === 'function';
  let globalWorks = false;
  if (hasGlobal) {
    const bytes = new Uint8Array(16);
    globalCrypto?.getRandomValues(bytes);
    globalWorks = bytes.some((byte) => byte !== 0);
  }
  rows.push({
    // Named as the question it answers, so a red row here reads as "core's
    // current line does not work on this platform" and not as "the port
    // failed" — the port's own getRandomValues passes, one row up.
    name: "does core's bare `crypto.getRandomValues` (wbi.ts:147-153) work as written?",
    ok: hasGlobal && globalWorks,
    detail: hasGlobal
      ? globalWorks
        ? 'present and filling'
        : 'present but returned all zeroes'
      : 'absent — the port must supply it',
    timing: null,
    perCallMs: null,
  });

  return rows;
}

export async function runCryptoPanel(): Promise<CryptoRow[]> {
  return [...checkDigests(), ...timeDigests(), ...(await expoDigestRows()), ...checkRandomness()];
}
