import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../db/index.js';
import { recordDeadLetter } from './changes.js';
import { makeLwwTriple } from './lww.js';
import { RETENTION_MS, runRetention } from './retention.js';
import { classifySyncFailure, nextSyncBackoffMs } from './retry.js';
import { readTombstone, writeTombstone } from './tombstones.js';

let sqlite: BetterSqlite3.Database;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
});

function insertChange(options: { syncedAt: number | null }): void {
  sqlite
    .prepare(
      `INSERT INTO sync_changes (device_id, entity_type, entity_id, op, payload, created_at,
         client_change_id, synced_at)
       VALUES ('local', 'song', ?, 'update', '{}', 1, ?, ?)`,
    )
    .run(randomUUID(), randomUUID(), options.syncedAt);
}

const changeCount = () =>
  (sqlite.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n;

describe('retention', () => {
  it('drops settled changes past the horizon and keeps everything else', () => {
    insertChange({ syncedAt: NOW - RETENTION_MS - 1 }); // old and settled
    insertChange({ syncedAt: NOW - 1000 }); // settled, but recent
    insertChange({ syncedAt: null }); // unpublished work

    const result = runRetention(sqlite, { nowMs: NOW });

    expect(result.removed).toBe(1);
    // A recent settled change still answers "is this echo mine" — self-replay
    // reads exactly these rows.
    expect(changeCount()).toBe(2);
  });

  it('never touches tombstones or dead letters', () => {
    const id = randomUUID();
    writeTombstone(sqlite, 'song', id, makeLwwTriple(1, 0, 'dev'), 1);
    recordDeadLetter(sqlite, { direction: 'in', reason: 'invalid_payload', nowMs: 1 });
    insertChange({ syncedAt: 1 });

    runRetention(sqlite, { nowMs: NOW });

    // Trimming a delete out of the outbox is only safe BECAUSE the tombstone
    // outlives it (D5); the archive is something a human will want to read.
    expect(readTombstone(sqlite, 'song', id)).not.toBeNull();
    expect(sqlite.prepare('SELECT count(*) AS n FROM sync_dead_letters').get()).toEqual({ n: 1 });
    expect(changeCount()).toBe(0);
  });
});

describe('classifying a failed round', () => {
  it.each([
    ['a rejected token', { status: 401 }, 'auth'],
    ['a forbidden workspace', { statusCode: 403 }, 'auth'],
    ['a malformed request', { status: 400 }, 'permanent'],
    ['a server fault', { status: 503 }, 'transient'],
    ['a rate limit', { status: 429 }, 'transient'],
    ['a timeout', { status: 408 }, 'transient'],
  ])('reads %s as %s', (_label, shape, kind) => {
    expect(classifySyncFailure(Object.assign(new Error('boom'), shape)).kind).toBe(kind);
  });

  it('treats a bare transport error as transient', () => {
    // No HTTP shape means the request never got an answer, and "try again" is
    // the definition of that. Calling it permanent would stop a laptop syncing
    // until somebody noticed.
    expect(classifySyncFailure(new Error('fetch failed')).kind).toBe('transient');
    expect(classifySyncFailure('not even an error').kind).toBe('transient');
  });

  it('backs off further each time, then flattens', () => {
    expect(nextSyncBackoffMs(0)).toBe(0);
    const delays = [1, 2, 3, 4, 5, 6, 20].map(nextSyncBackoffMs);
    for (let i = 1; i < 5; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    expect(delays[5]).toBe(delays[4]);
    expect(delays[6]).toBe(delays[4]);
  });
});
