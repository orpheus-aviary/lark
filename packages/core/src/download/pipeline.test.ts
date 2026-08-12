// The by-key lookup, once D8 made a duplicate key possible.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DatabaseHandles, createDatabase } from '../db/index.js';
import { AmbiguousSourceKeyError } from '../errors.js';
import { createSong } from '../library/songs.js';
import { findSongByKey, findSongsByKey } from './pipeline.js';

let nest: string;
let handles: DatabaseHandles;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-pipeline-test-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  handles = createDatabase({ dbPath: ':memory:' });
});

afterEach(() => {
  handles.sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

/** The second holder of a key: only sync can create one, so insert it directly. */
function insertPeerSong(id: string, key: string): void {
  handles.sqlite
    .prepare(
      `INSERT INTO songs (id, name, artist, source_provider, source_key, file_origin,
         created_at, updated_at)
       VALUES (?, 'from a peer', '', 'bilibili', ?, 'downloaded', 1000, 1000)`,
    )
    .run(id, key);
}

describe('findSongByKey', () => {
  it('finds the one holder, and nothing when there is none', () => {
    const song = createSong(handles.db, handles.sqlite, {
      name: 's',
      source_provider: 'bilibili',
      source_key: 'BVaa:1',
    });
    expect(findSongByKey(handles.db, 'bilibili', 'BVaa:1')).toEqual({ id: song.id });
    expect(findSongByKey(handles.db, 'bilibili', 'BVzz:9')).toBeUndefined();
  });

  it('names the ambiguity instead of picking one', () => {
    const mine = createSong(handles.db, handles.sqlite, {
      name: 'mine',
      source_provider: 'bilibili',
      source_key: 'BVdup:1',
    });
    const peer = '9b2abf8a-6b31-40d4-a2f1-8e5c3d21a0ff';
    insertPeerSong(peer, 'BVdup:1');

    // Picking whichever row SQLite hands back first would attach a download —
    // or an import match — to an arbitrary one of two songs the user can see
    // are different.
    let caught: unknown;
    try {
      findSongByKey(handles.db, 'bilibili', 'BVdup:1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AmbiguousSourceKeyError);
    expect((caught as AmbiguousSourceKeyError).songIds).toEqual([mine.id, peer].sort());
    expect((caught as AmbiguousSourceKeyError).code).toBe('AMBIGUOUS_SOURCE_KEY');
  });

  it('lists every holder in a stable order', () => {
    const mine = createSong(handles.db, handles.sqlite, {
      name: 'mine',
      source_provider: 'bilibili',
      source_key: 'BVdup:1',
    });
    const peer = '9b2abf8a-6b31-40d4-a2f1-8e5c3d21a0ff';
    insertPeerSong(peer, 'BVdup:1');

    expect(findSongsByKey(handles.db, 'bilibili', 'BVdup:1').map((s) => s.id)).toEqual(
      [mine.id, peer].sort(),
    );
  });
});
