// HLC-lite stamping (v0.2 T1, §3.3 / R32-②).
//
// v0.1 stamped rows with a row-local `nextLwwStamp(prev)`: fine for a single
// machine, wrong the moment two of them compare keys. Two failure modes it
// cannot address:
//
//   1. A device whose system clock runs fast writes ever-larger `updated_at`
//      and wins every conflict in the workspace, forever.
//   2. Two writes to DIFFERENT rows in the same millisecond both stamp
//      `(now, 0)`, so nothing orders them against a peer's view.
//
// So the clock becomes hybrid and device-global: a physical part re-based onto
// the server's timeline (`server_time_offset_ms`, refreshed every sync round)
// and a counter that advances whenever the physical part does not. State lives
// in `local_metadata`, and a stamp MUST be taken inside the same transaction as
// the write it stamps — otherwise the persisted clock and the stamped row can
// disagree after a crash.
//
// Registration-time rebase (§3.3 step 1) is a login-transaction job and lands
// with the backfill it must run after; this module owns the running clock.

import type BetterSqlite3 from 'better-sqlite3';
import type { LwwTriple } from './lww.js';

const KEY_OFFSET = 'sync_server_time_offset_ms';
const KEY_LAST_MS = 'sync_hlc_last_ms';
const KEY_LAST_COUNTER = 'sync_hlc_last_counter';

/** What a business write stamps onto its row. Column names, not wire names. */
export interface LwwStamp {
  updated_at: number;
  lww_counter: number;
}

function readInt(sqlite: BetterSqlite3.Database, key: string): number | null {
  const row = sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  if (!row || row.value === null) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

function writeInt(sqlite: BetterSqlite3.Database, key: string, value: number): void {
  sqlite
    .prepare(
      `INSERT INTO local_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, String(value));
}

/** Persist `serverTime − localNow`, so the next stamp lands on the server's timeline. */
export function setServerTimeOffset(sqlite: BetterSqlite3.Database, offsetMs: number): void {
  writeInt(sqlite, KEY_OFFSET, Math.trunc(offsetMs));
}

/** The current offset, or 0 before the first successful round (bare local clock). */
export function readServerTimeOffset(sqlite: BetterSqlite3.Database): number {
  return readInt(sqlite, KEY_OFFSET) ?? 0;
}

/**
 * The next stamp for a local write, with the advanced clock persisted.
 *
 * Strictly monotonic per device: when the re-based physical clock does not
 * move past the last stamp (same millisecond, or an offset that jumped
 * backwards), the millisecond is held and the counter advances instead.
 */
export function nextSyncStamp(
  sqlite: BetterSqlite3.Database,
  nowMs: () => number = Date.now,
): LwwStamp {
  const phys = nowMs() + (readInt(sqlite, KEY_OFFSET) ?? 0);
  const lastMs = readInt(sqlite, KEY_LAST_MS) ?? 0;
  const lastCounter = readInt(sqlite, KEY_LAST_COUNTER) ?? 0;

  const ms = phys > lastMs ? phys : lastMs;
  const counter = phys > lastMs ? 0 : lastCounter + 1;

  writeInt(sqlite, KEY_LAST_MS, ms);
  writeInt(sqlite, KEY_LAST_COUNTER, counter);
  return { updated_at: ms, lww_counter: counter };
}

/**
 * Advance the clock past a remote key seen during apply.
 *
 * Bumping only on local writes is not enough: after adopting a peer's newer
 * key, the very next local edit would tie with — or lose to — the value the
 * user just saw arrive. Observing every applied key makes the next local stamp
 * outrank everything this device has already seen.
 */
export function observeRemoteLww(sqlite: BetterSqlite3.Database, remote: LwwTriple): void {
  const lastMs = readInt(sqlite, KEY_LAST_MS) ?? 0;
  const lastCounter = readInt(sqlite, KEY_LAST_COUNTER) ?? 0;
  if (remote.ms > lastMs) {
    writeInt(sqlite, KEY_LAST_MS, remote.ms);
    writeInt(sqlite, KEY_LAST_COUNTER, remote.counter);
  } else if (remote.ms === lastMs && remote.counter > lastCounter) {
    writeInt(sqlite, KEY_LAST_COUNTER, remote.counter);
  }
  // Strictly older: nothing to learn.
}

/** The clock's current position, for the rebase seed and for tests. */
export function readHlcState(sqlite: BetterSqlite3.Database): LwwStamp {
  return {
    updated_at: readInt(sqlite, KEY_LAST_MS) ?? 0,
    lww_counter: readInt(sqlite, KEY_LAST_COUNTER) ?? 0,
  };
}

/**
 * Seed the clock so every later stamp outranks `seed`.
 *
 * Used by the login-time rebase, which rewrites keys in bulk and then has to
 * leave the running clock above everything it produced.
 */
export function seedHlc(sqlite: BetterSqlite3.Database, seed: LwwStamp): void {
  const current = readHlcState(sqlite);
  if (
    seed.updated_at > current.updated_at ||
    (seed.updated_at === current.updated_at && seed.lww_counter > current.lww_counter)
  ) {
    writeInt(sqlite, KEY_LAST_MS, seed.updated_at);
    writeInt(sqlite, KEY_LAST_COUNTER, seed.lww_counter);
  }
}
