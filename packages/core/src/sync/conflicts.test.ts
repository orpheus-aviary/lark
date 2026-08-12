import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DatabaseHandles, createDatabase } from '../db/index.js';
import { ConflictVersionMismatchError } from '../errors.js';
import { createSong } from '../library/songs.js';
import { type InboundChange, applyChangesInTx } from './apply.js';
import { conflictWinnerKey, listConflicts, resolveConflict } from './conflicts.js';

let nest: string;
let handles: DatabaseHandles;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-conflicts-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  handles = createDatabase({ dbPath: ':memory:' });
});

afterEach(() => {
  handles.sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const db = () => handles.db;
const sq = () => handles.sqlite;

const remoteUpdate = (songId: string, name: string, ms: number): InboundChange => ({
  server_seq: 1,
  device_id: 'peer-1',
  client_change_id: randomUUID(),
  entity_type: 'song',
  entity_id: songId,
  op: 'update',
  payload: {
    name,
    artist: '',
    source_url: null,
    source_provider: null,
    source_key: null,
    lyrics_offset: 0,
    duration: 0,
    created_at_ms: 1000,
    updated_at_ms: ms,
    lww_counter: 0,
  },
});

/** A song this device edited, then lost to a peer. */
function makeConflict(): { songId: string; conflictId: string } {
  const song = createSong(db(), sq(), { name: '我的名字' });
  sq()
    .transaction(() => applyChangesInTx(sq(), [remoteUpdate(song.id, '远端名字', 9e12)]))
    .immediate();
  const [conflict] = listConflicts(sq());
  return { songId: song.id, conflictId: conflict.id };
}

const songName = (id: string) =>
  (sq().prepare('SELECT name FROM songs WHERE id = ?').get(id) as { name: string }).name;

const emittedOps = (id: string) =>
  (
    sq().prepare('SELECT op FROM sync_changes WHERE entity_id = ? ORDER BY local_seq').all(id) as {
      op: string;
    }[]
  ).map((c) => c.op);

describe('resolveConflict', () => {
  it('keeping the remote version only files the receipt', () => {
    const { songId, conflictId } = makeConflict();
    const expected = conflictWinnerKey(listConflicts(sq())[0]);

    resolveConflict(db(), sq(), conflictId, { strategy: 'remote', expected_current: expected });

    expect(songName(songId)).toBe('远端名字');
    expect(listConflicts(sq())).toHaveLength(0);
    // Nothing new to say: the row already holds what the workspace decided.
    expect(emittedOps(songId)).toEqual(['create']);
  });

  it('restoring the local version writes it back and publishes it', () => {
    const { songId, conflictId } = makeConflict();
    const expected = conflictWinnerKey(listConflicts(sq())[0]);

    resolveConflict(db(), sq(), conflictId, { strategy: 'local', expected_current: expected });

    expect(songName(songId)).toBe('我的名字');
    expect(listConflicts(sq())).toHaveLength(0);
    // A restore is an edit: it goes through the ordinary write path, takes a
    // fresh key, and is published like any other.
    expect(emittedOps(songId)).toEqual(['create', 'update']);
  });

  it('refuses when the song moved on again', () => {
    const { songId, conflictId } = makeConflict();
    const stale = conflictWinnerKey(listConflicts(sq())[0]);

    // A third device writes while the user is still looking at the conflict.
    sq()
      .transaction(() => applyChangesInTx(sq(), [remoteUpdate(songId, '第三台设备', 9e12 + 1)]))
      .immediate();

    expect(() =>
      resolveConflict(db(), sq(), conflictId, { strategy: 'local', expected_current: stale }),
    ).toThrow(ConflictVersionMismatchError);
    // Restoring over the third device's edit would undo a change nobody saw.
    expect(songName(songId)).toBe('第三台设备');
  });

  it('refuses a second answer to the same conflict', () => {
    const { conflictId } = makeConflict();
    const expected = conflictWinnerKey(listConflicts(sq())[0]);
    resolveConflict(db(), sq(), conflictId, { strategy: 'remote', expected_current: expected });

    expect(() =>
      resolveConflict(db(), sq(), conflictId, { strategy: 'local', expected_current: expected }),
    ).toThrow(ConflictVersionMismatchError);
  });

  it('refuses when the song is gone entirely', () => {
    const { songId, conflictId } = makeConflict();
    const expected = conflictWinnerKey(listConflicts(sq())[0]);
    sq().prepare('DELETE FROM songs WHERE id = ?').run(songId);

    expect(() =>
      resolveConflict(db(), sq(), conflictId, { strategy: 'local', expected_current: expected }),
    ).toThrow(ConflictVersionMismatchError);
  });
});
