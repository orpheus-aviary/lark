import { isUuidV4 } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import { SyncChangeTooLargeError } from '../errors.js';
import {
  countDeadLetters,
  countPendingChanges,
  emitSyncChange,
  readLocalDeviceUuid,
  recordDeadLetter,
} from './changes.js';

let sqlite: BetterSqlite3.Database;

beforeEach(() => {
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
});

const songPayload = (overrides: Record<string, unknown> = {}) => ({
  name: 'song',
  artist: '',
  source_url: null,
  source_provider: null,
  source_key: null,
  lyrics_offset: 0,
  duration: 0,
  created_at_ms: 1000,
  updated_at_ms: 1000,
  lww_counter: 0,
  ...overrides,
});

describe('emitSyncChange', () => {
  it('appends a row stamped with a fresh cid and the LOCAL device uuid', () => {
    const cid = emitSyncChange(sqlite, {
      entityType: 'song',
      entityId: 'a2f6b2f0-0000-4000-8000-000000000001',
      op: 'create',
      payload: songPayload(),
      nowMs: 1234,
    });

    expect(isUuidV4(cid)).toBe(true);
    const row = sqlite.prepare('SELECT * FROM sync_changes').get() as {
      device_id: string;
      entity_type: string;
      op: string;
      payload: string;
      created_at: number;
      client_change_id: string;
      synced_at: number | null;
      server_seq: number | null;
    };
    // The forensic device id is this install's local uuid, NOT the skybridge
    // registration id that lives on entity rows (R18).
    expect(row.device_id).toBe(readLocalDeviceUuid(sqlite));
    expect(row.entity_type).toBe('song');
    expect(row.op).toBe('create');
    expect(JSON.parse(row.payload)).toEqual(songPayload());
    expect(row.created_at).toBe(1234);
    expect(row.client_change_id).toBe(cid);
    expect(row.synced_at).toBeNull();
    expect(row.server_seq).toBeNull();
  });

  it('counts as pending until it is marked synced', () => {
    emitSyncChange(sqlite, {
      entityType: 'song',
      entityId: 'a2f6b2f0-0000-4000-8000-000000000001',
      op: 'create',
      payload: songPayload(),
    });
    expect(countPendingChanges(sqlite)).toBe(1);

    sqlite.prepare('UPDATE sync_changes SET synced_at = 1').run();
    expect(countPendingChanges(sqlite)).toBe(0);
  });

  it('refuses an oversize change BEFORE writing anything', () => {
    // A change the server would reject must never enter the outbox: it would
    // sit at the head of the queue and block every change behind it.
    const huge = 'x'.repeat(300 * 1024);
    expect(() =>
      emitSyncChange(sqlite, {
        entityType: 'song',
        entityId: 'a2f6b2f0-0000-4000-8000-000000000001',
        op: 'set_lyrics',
        payload: { lrc: huge },
      }),
    ).toThrow(SyncChangeTooLargeError);
    expect(countPendingChanges(sqlite)).toBe(0);
  });

  it('measures the envelope, not just the payload', () => {
    // 239KB of payload fits; the same payload plus a hair does not, which is
    // only true if the envelope is being counted too.
    const lrc = 'x'.repeat(239 * 1024);
    expect(() =>
      emitSyncChange(sqlite, {
        entityType: 'song',
        entityId: 'a2f6b2f0-0000-4000-8000-000000000001',
        op: 'set_lyrics',
        payload: { lrc },
      }),
    ).not.toThrow();

    let bytes = 0;
    try {
      emitSyncChange(sqlite, {
        entityType: 'song',
        entityId: 'a2f6b2f0-0000-4000-8000-000000000001',
        op: 'set_lyrics',
        payload: { lrc: 'x'.repeat(240 * 1024) },
      });
    } catch (err) {
      bytes = (err as SyncChangeTooLargeError).bytes;
    }
    expect(bytes).toBeGreaterThan(240 * 1024);
  });

  it('refuses to guess an identity when the device uuid is missing', () => {
    sqlite.prepare("DELETE FROM local_metadata WHERE key='device_uuid'").run();
    expect(() =>
      emitSyncChange(sqlite, {
        entityType: 'song',
        entityId: 'a2f6b2f0-0000-4000-8000-000000000001',
        op: 'create',
        payload: songPayload(),
      }),
    ).toThrow(/device_uuid/);
  });
});

describe('dead letters', () => {
  it('keeps the whole inbound envelope and counts by direction', () => {
    const envelope = JSON.stringify({
      server_seq: 42,
      client_change_id: 'c1',
      device_id: 'dev-1',
      entity_type: 'song',
      entity_id: 'x',
      op: 'create',
      payload: { name: 12 },
      client_local_seq: 7,
      client_created_at: 1000,
      server_received_at: 1001,
    });
    recordDeadLetter(sqlite, {
      direction: 'in',
      reason: 'invalid_payload',
      serverSeq: 42,
      clientChangeId: 'c1',
      deviceId: 'dev-1',
      entityType: 'song',
      entityId: 'x',
      op: 'create',
      payload: envelope,
      nowMs: 5,
    });
    recordDeadLetter(sqlite, { direction: 'out', reason: 'change_too_large', nowMs: 6 });

    expect(countDeadLetters(sqlite)).toEqual({ in: 1, out: 1 });
    const stored = sqlite
      .prepare("SELECT payload FROM sync_dead_letters WHERE direction='in'")
      .get() as { payload: string };
    // Whole envelope, not the three-field summary: an archive you cannot
    // replay is a log line with extra steps.
    expect(JSON.parse(stored.payload)).toMatchObject({
      server_seq: 42,
      client_local_seq: 7,
      server_received_at: 1001,
    });
  });
});
