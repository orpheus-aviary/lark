import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseHandles, createDatabase } from '../../db/index.js';
import { emitSyncChange, readLocalDeviceUuid } from './changes.js';
import {
  clearSkybridgeDeviceId,
  readSkybridgeDeviceId,
  setSkybridgeDeviceId,
  stampDeviceIdInTx,
} from './device.js';
import { writeTombstone } from './tombstones.js';

let handles: DatabaseHandles;

beforeEach(() => {
  handles = createDatabase({ dbPath: ':memory:' });
});

afterEach(() => {
  handles.sqlite.close();
});

const sq = () => handles.sqlite;

function insertSong(deviceId: string | null): string {
  const id = randomUUID();
  sq()
    .prepare(
      `INSERT INTO songs (id, name, artist, file_origin, created_at, updated_at, lww_counter, device_id)
       VALUES (?, 'n', 'a', 'downloaded', 1, 1, 0, ?)`,
    )
    .run(id, deviceId);
  return id;
}

function emitPendingUpdate(songId: string): void {
  emitSyncChange(sq(), {
    entityType: 'song',
    entityId: songId,
    op: 'update',
    payload: {
      name: 'n',
      artist: 'a',
      source_url: null,
      source_provider: null,
      source_key: null,
      lyrics_offset: 0,
      duration: 0,
      created_at_ms: 1,
      updated_at_ms: 2,
      lww_counter: 0,
    },
  });
}

const deviceOf = (songId: string): string | null =>
  (
    sq().prepare('SELECT device_id FROM songs WHERE id = ?').get(songId) as {
      device_id: string | null;
    }
  ).device_id;

describe('skybridge device id', () => {
  it('reads back what was set, and null once cleared', () => {
    expect(readSkybridgeDeviceId(sq())).toBeNull();
    setSkybridgeDeviceId(sq(), 'device-1');
    expect(readSkybridgeDeviceId(sq())).toBe('device-1');
    clearSkybridgeDeviceId(sq());
    expect(readSkybridgeDeviceId(sq())).toBeNull();
  });
});

describe('stampDeviceIdInTx — first registration', () => {
  it('adopts every row that has no registered id yet', () => {
    const local = readLocalDeviceUuid(sq());
    const nullRow = insertSong(null);
    const legacyRow = insertSong(local); // v0.1 stamped the local uuid here
    const foreignRow = insertSong('someone-else'); // arrived from a peer

    const result = stampDeviceIdInTx(sq(), {
      deviceId: 'device-1',
      previousId: null,
      localUuid: local,
    });

    expect(result.mode).toBe('first-registration');
    expect(deviceOf(nullRow)).toBe('device-1');
    expect(deviceOf(legacyRow)).toBe('device-1');
    // Never ours to claim: a peer wrote it, and the key says so.
    expect(deviceOf(foreignRow)).toBe('someone-else');
  });

  it('stamps tombstones too — a delete carries a key like any other write', () => {
    const local = readLocalDeviceUuid(sq());
    const goneId = randomUUID();
    // `''`, not NULL: the LWW triple normalizes "no device" on the way in, so
    // that is the shape a pre-registration tombstone actually has on disk.
    writeTombstone(sq(), 'song', goneId, { ms: 10, counter: 0, deviceId: '' }, 10);

    stampDeviceIdInTx(sq(), { deviceId: 'device-1', previousId: null, localUuid: local });

    const row = sq()
      .prepare('SELECT device_id FROM sync_tombstones WHERE entity_id = ?')
      .get(goneId) as { device_id: string | null };
    expect(row.device_id).toBe('device-1');
  });
});

describe('stampDeviceIdInTx — device changed', () => {
  it('restamps only what has not been published yet', () => {
    const local = readLocalDeviceUuid(sq());
    const pushed = insertSong('device-1');
    const pending = insertSong('device-1');
    emitPendingUpdate(pending);
    // A settled change must not count as pending work.
    emitPendingUpdate(pushed);
    sq().prepare('UPDATE sync_changes SET synced_at = 100 WHERE entity_id = ?').run(pushed);

    const result = stampDeviceIdInTx(sq(), {
      deviceId: 'device-2',
      previousId: 'device-1',
      localUuid: local,
    });

    expect(result.mode).toBe('device-changed');
    expect(deviceOf(pending)).toBe('device-2');
    // Already in the workspace under device-1: rewriting it here would make
    // this library disagree with every peer about who wrote it.
    expect(deviceOf(pushed)).toBe('device-1');
  });

  it('ignores rank and lyrics ops — they carry no key to re-attribute', () => {
    const local = readLocalDeviceUuid(sq());
    const song = insertSong('device-1');
    emitSyncChange(sq(), {
      entityType: 'song',
      entityId: song,
      op: 'set_lyrics',
      payload: { lrc: '[00:00.00] hi' },
    });

    stampDeviceIdInTx(sq(), { deviceId: 'device-2', previousId: 'device-1', localUuid: local });

    expect(deviceOf(song)).toBe('device-1');
  });

  it('does nothing when the id has not moved', () => {
    const local = readLocalDeviceUuid(sq());
    const song = insertSong('device-1');
    emitPendingUpdate(song);

    const result = stampDeviceIdInTx(sq(), {
      deviceId: 'device-1',
      previousId: 'device-1',
      localUuid: local,
    });

    expect(result.mode).toBe('unchanged');
    expect(result.updated).toEqual({});
    expect(deviceOf(song)).toBe('device-1');
  });
});
