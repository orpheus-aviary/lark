import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DatabaseHandles, createDatabase } from '../db/index.js';
import { createPlaylist } from '../library/playlists.js';
import { createSong, deleteSong } from '../library/songs.js';
import { runFullBackfill } from './backfill.js';
import { FileEffectRuntime } from './file-ops-runtime.js';
import { readHlcState } from './hlc.js';
import { REBASE_TOLERANCE_MS, rebaseLocalKeys } from './rebase.js';

let nest: string;
let handles: DatabaseHandles;

/** "Now" on the server. Local rows below are stamped a year ahead of it. */
const SERVER_NOW = 1_800_000_000_000;
const FUTURE = SERVER_NOW + 365 * 24 * 3600 * 1000;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-rebase-'));
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

/** A song stamped by a badly wrong clock, with its create still unpushed. */
async function seedFutureSong(ms: number = FUTURE): Promise<string> {
  const song = createSong(db(), sq(), { name: '未来的歌' });
  sq().prepare('UPDATE songs SET updated_at = ?, lww_counter = 0 WHERE id = ?').run(ms, song.id);
  sq().prepare('DELETE FROM sync_changes').run();
  await runFullBackfill(sq()); // the create the rebase will rewrite
  return song.id;
}

const songKey = (id: string) =>
  sq().prepare('SELECT updated_at, lww_counter FROM songs WHERE id = ?').get(id) as {
    updated_at: number;
    lww_counter: number;
  };

const pendingPayloads = (entityId: string) =>
  (
    sq()
      .prepare('SELECT op, payload FROM sync_changes WHERE entity_id = ? ORDER BY local_seq')
      .all(entityId) as { op: string; payload: string }[]
  ).map((c) => ({ op: c.op, payload: JSON.parse(c.payload) }));

describe('rebaseLocalKeys', () => {
  it('collapses a future-dated entity onto the server clock', async () => {
    const songId = await seedFutureSong();

    const result = rebaseLocalKeys(sq(), SERVER_NOW);

    expect(result).toMatchObject({ entities: 1, ops: 1 });
    // The row and the op it will be pushed as must agree, or the workspace
    // would see a key this device does not think it has.
    expect(songKey(songId)).toEqual({ updated_at: SERVER_NOW, lww_counter: 0 });
    expect(pendingPayloads(songId)[0].payload).toMatchObject({
      updated_at_ms: SERVER_NOW,
      lww_counter: 0,
    });
  });

  it('keeps the order of an entity’s own edits', async () => {
    const songId = await seedFutureSong();
    // Two more pending edits, all still in the future.
    for (const [i, name] of ['二', '三'].entries()) {
      sq()
        .prepare(
          `INSERT INTO sync_changes (device_id, entity_type, entity_id, op, payload, created_at,
             client_change_id)
           VALUES ('local', 'song', ?, 'update', ?, 1, ?)`,
        )
        .run(
          songId,
          JSON.stringify({
            name,
            artist: '',
            source_url: null,
            source_provider: null,
            source_key: null,
            lyrics_offset: 0,
            duration: 0,
            created_at_ms: 1,
            updated_at_ms: FUTURE + i + 1,
            lww_counter: 0,
          }),
          randomUUID(),
        );
    }

    const result = rebaseLocalKeys(sq(), SERVER_NOW);

    expect(result.ops).toBe(3);
    // One entity, one collapsed timeline: (server_now, 0..k) keeps a later
    // edit ahead of an earlier one.
    expect(pendingPayloads(songId).map((c) => c.payload.lww_counter)).toEqual([0, 1, 2]);
    expect(pendingPayloads(songId).every((c) => c.payload.updated_at_ms === SERVER_NOW)).toBe(true);
    expect(songKey(songId)).toEqual({ updated_at: SERVER_NOW, lww_counter: 2 });
  });

  it('rewrites a tombstone together with the delete that made it', async () => {
    const songId = await seedFutureSong();
    await deleteSong(db(), sq(), songId, { fileOps: new FileEffectRuntime({ sqlite: sq() }) });
    sq()
      .prepare('UPDATE sync_tombstones SET updated_at = ? WHERE entity_id = ?')
      .run(FUTURE + 5, songId);
    sq()
      .prepare(
        `UPDATE sync_changes SET payload = json_set(payload, '$.updated_at_ms', ?)
         WHERE entity_id = ? AND op = 'delete'`,
      )
      .run(FUTURE + 5, songId);

    rebaseLocalKeys(sq(), SERVER_NOW);

    const grave = sq()
      .prepare('SELECT updated_at, lww_counter FROM sync_tombstones WHERE entity_id = ?')
      .get(songId) as { updated_at: number; lww_counter: number };
    // A tombstone that kept its future key would outrank the delete that
    // carries it, and the two would disagree about the same event.
    expect(grave.updated_at).toBe(SERVER_NOW);
    const deleteOp = pendingPayloads(songId).find((c) => c.op === 'delete');
    expect(deleteOp?.payload.updated_at_ms).toBe(SERVER_NOW);
  });

  it('leaves keys inside the tolerance alone', async () => {
    const songId = await seedFutureSong(SERVER_NOW + REBASE_TOLERANCE_MS - 1);
    const before = songKey(songId);

    const result = rebaseLocalKeys(sq(), SERVER_NOW);

    // A clock a couple of minutes fast is normal; only damage gets rewritten.
    expect(result.entities).toBe(0);
    expect(songKey(songId)).toEqual(before);
  });

  it('does not touch metadata ops, which carry no key at all', async () => {
    const songId = await seedFutureSong();
    const playlistId = createPlaylist(db(), sq(), 'p').id;
    sq()
      .prepare(
        `INSERT INTO sync_changes (device_id, entity_type, entity_id, op, payload, created_at,
           client_change_id)
         VALUES ('local', 'song', ?, 'set_lyrics', ?, 1, ?)`,
      )
      .run(songId, JSON.stringify({ lrc: '[00:01.00]x' }), randomUUID());

    rebaseLocalKeys(sq(), SERVER_NOW);

    const lyrics = pendingPayloads(songId).find((c) => c.op === 'set_lyrics');
    expect(lyrics?.payload).toEqual({ lrc: '[00:01.00]x' });
    expect(playlistId).toHaveLength(36);
  });

  it('leaves the clock above everything it can still see', async () => {
    await seedFutureSong();
    // An entity inside the tolerance keeps its key, so the seed has to come
    // from the whole local state rather than from what was rewritten.
    const recent = createSong(db(), sq(), { name: '刚刚' });
    sq()
      .prepare('UPDATE songs SET updated_at = ?, lww_counter = 4 WHERE id = ?')
      .run(SERVER_NOW + 1000, recent.id);

    const result = rebaseLocalKeys(sq(), SERVER_NOW);

    expect(result.seed.updated_at).toBeGreaterThanOrEqual(SERVER_NOW + 1000);
    expect(readHlcState(sq()).updated_at).toBeGreaterThanOrEqual(SERVER_NOW + 1000);
  });
});

describe('the rebase can read its own writing', () => {
  it('a later rebase still sees the payloads an earlier one rewrote', async () => {
    const songId = await seedFutureSong();
    rebaseLocalKeys(sq(), SERVER_NOW);

    // SQLite's json_set stores a bound number as `1800000000000.0` unless it
    // is CAST — which would make the rewritten key invisible to a gate that
    // only accepts json_type 'integer'. Both halves are asserted here: the
    // stored type, and a second pass actually finding the op.
    const storedType = sq()
      .prepare(
        `SELECT json_type(payload, '$.updated_at_ms') AS t FROM sync_changes
         WHERE entity_id = ? AND op = 'create'`,
      )
      .get(songId) as { t: string };
    expect(storedType.t).toBe('integer');

    const earlierServer = SERVER_NOW - 24 * 3600 * 1000;
    const again = rebaseLocalKeys(sq(), earlierServer);
    expect(again).toMatchObject({ entities: 1, ops: 1 });
    expect(songKey(songId)).toEqual({ updated_at: earlierServer, lww_counter: 0 });
  });
});
