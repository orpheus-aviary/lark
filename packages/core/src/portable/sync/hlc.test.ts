import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../db/index.js';
import {
  nextSyncStamp,
  observeRemoteLww,
  readHlcState,
  readServerTimeOffset,
  seedHlc,
  setServerTimeOffset,
} from './hlc.js';
import { makeLwwTriple } from './lww.js';

let sqlite: BetterSqlite3.Database;

beforeEach(() => {
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
});

describe('nextSyncStamp', () => {
  it('advances the counter when the physical clock stands still', () => {
    const frozen = () => 1_000_000;
    expect(nextSyncStamp(sqlite, frozen)).toEqual({ updated_at: 1_000_000, lww_counter: 0 });
    expect(nextSyncStamp(sqlite, frozen)).toEqual({ updated_at: 1_000_000, lww_counter: 1 });
    expect(nextSyncStamp(sqlite, frozen)).toEqual({ updated_at: 1_000_000, lww_counter: 2 });
  });

  it('resets the counter once the clock moves on', () => {
    nextSyncStamp(sqlite, () => 1_000_000);
    expect(nextSyncStamp(sqlite, () => 1_000_001)).toEqual({
      updated_at: 1_000_001,
      lww_counter: 0,
    });
  });

  it('holds the logical clock when the local clock jumps backwards', () => {
    // The device-global counter is the whole point: a user fixing their system
    // clock must not be able to write keys that lose to their own past.
    nextSyncStamp(sqlite, () => 5_000_000);
    expect(nextSyncStamp(sqlite, () => 1_000)).toEqual({
      updated_at: 5_000_000,
      lww_counter: 1,
    });
  });

  it('re-bases onto the server timeline', () => {
    setServerTimeOffset(sqlite, 60_000);
    expect(readServerTimeOffset(sqlite)).toBe(60_000);
    expect(nextSyncStamp(sqlite, () => 1_000_000)).toEqual({
      updated_at: 1_060_000,
      lww_counter: 0,
    });
  });

  it('survives being read back from the database', () => {
    nextSyncStamp(sqlite, () => 2_000_000);
    nextSyncStamp(sqlite, () => 2_000_000);
    expect(readHlcState(sqlite)).toEqual({ updated_at: 2_000_000, lww_counter: 1 });
  });
});

describe('observeRemoteLww', () => {
  it('makes the next local stamp outrank a key just applied', () => {
    nextSyncStamp(sqlite, () => 1_000);
    observeRemoteLww(sqlite, makeLwwTriple(9_000, 4, 'peer'));

    const next = nextSyncStamp(sqlite, () => 1_001);
    // The local clock is behind the peer's, so the counter carries the order.
    expect(next).toEqual({ updated_at: 9_000, lww_counter: 5 });
  });

  it('bumps only the counter on an equal millisecond', () => {
    nextSyncStamp(sqlite, () => 1_000);
    observeRemoteLww(sqlite, makeLwwTriple(1_000, 7, 'peer'));
    expect(readHlcState(sqlite)).toEqual({ updated_at: 1_000, lww_counter: 7 });
  });

  it('learns nothing from a strictly older key', () => {
    nextSyncStamp(sqlite, () => 5_000);
    observeRemoteLww(sqlite, makeLwwTriple(4_000, 99, 'peer'));
    expect(readHlcState(sqlite)).toEqual({ updated_at: 5_000, lww_counter: 0 });
  });
});

describe('seedHlc', () => {
  it('raises the clock but never lowers it', () => {
    nextSyncStamp(sqlite, () => 3_000);
    seedHlc(sqlite, { updated_at: 9_000, lww_counter: 2 });
    expect(readHlcState(sqlite)).toEqual({ updated_at: 9_000, lww_counter: 2 });

    seedHlc(sqlite, { updated_at: 1_000, lww_counter: 0 });
    expect(readHlcState(sqlite)).toEqual({ updated_at: 9_000, lww_counter: 2 });
  });
});
