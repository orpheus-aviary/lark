// Criteria 86 · 87 — the phone's half of the import digest (N6a).
//
// 87 is a PARITY claim and 86 is a NUMBER, and they share a probe because they
// share the one thing only a device can answer: what `expo-crypto` does. The
// desktop half of 87 lives in `library/import.test.ts`; both compare against
// the same `shasum`-derived constant, neither computes it.
//
// 86 has no threshold on purpose (N6 subplan). The real ceiling is a 10,000
// song file — about 2MB — and the 20MB case is here because that is the cap
// the route enforces, so it is the worst input this path can be handed. What
// the number is FOR is the "出口 B" question N0b-3 left open: whether hashing
// a whole file has to move off the JS thread. It already has — `digest` is a
// native async call — so this measures the cost of the call, bridge included.

import { sha256BytesAsync } from '@lark/core/portable';
import { installPortableRuntime } from '../boot/runtime';
import type { ScenarioRow } from './d16';
import { IMPORT_FIXTURE_DIGEST, IMPORT_FIXTURE_JSON } from './import-fixture';

const HEX_64 = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

/** Nearest-rank p95 (N0 §3.2a). Over five samples that is the slowest one. */
function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

async function timeDigest(megabytes: number): Promise<ScenarioRow> {
  // Zeros: a hash costs the same whatever the bytes are, and what is being
  // measured here is mostly the trip across the bridge.
  const bytes = new Uint8Array(megabytes * 1024 * 1024);
  const samples: number[] = [];
  let hex = '';
  for (let i = 0; i < 5; i += 1) {
    const started = Date.now();
    hex = await sha256BytesAsync(bytes);
    samples.push(Date.now() - started);
  }
  return {
    name: `86 · sha256 over ${megabytes}MB (measurement, no threshold)`,
    // The row is not green for being fast — it is green for having produced a
    // digest at all. The number is in the detail, where a measurement belongs.
    ok: HEX_64.test(hex),
    detail: `p95 ${p95(samples)}ms · ${samples.join('/')}ms`,
  };
}

export async function runImportDigestScenarios(): Promise<ScenarioRow[]> {
  installPortableRuntime();
  const rows: ScenarioRow[] = [];

  const digest = await sha256BytesAsync(encoder.encode(IMPORT_FIXTURE_JSON));
  rows.push({
    name: '87 · same bytes, same digest as the desktop',
    ok: digest === IMPORT_FIXTURE_DIGEST,
    // Printed either way: a mismatch is only diagnosable next to what it got.
    detail: digest === IMPORT_FIXTURE_DIGEST ? digest : `${digest} ≠ ${IMPORT_FIXTURE_DIGEST}`,
  });

  rows.push(await timeDigest(2));
  rows.push(await timeDigest(20));
  return rows;
}
