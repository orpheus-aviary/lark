import type { SongData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { duplicateSourceKeyIds } from './duplicates.js';

function song(id: string, provider: string | null, key: string | null): SongData {
  return {
    id,
    name: id,
    artist: '',
    source_url: null,
    source_provider: provider,
    source_key: key,
    file_origin: 'downloaded',
    lyrics_offset: 0,
    duration: 0,
    pinned: false,
    created_at: 0,
    updated_at: 0,
  };
}

describe('duplicateSourceKeyIds', () => {
  it('marks every member of a colliding group, not just the later one', () => {
    const ids = duplicateSourceKeyIds([
      song('a', 'bilibili', 'BV1:1'),
      song('b', 'bilibili', 'BV1:1'),
      song('c', 'bilibili', 'BV2:1'),
    ]);

    expect([...ids].sort()).toEqual(['a', 'b']);
  });

  // Songs with no source (the Go migration left 20 of them) are not duplicates
  // of each other — only a real (provider, key) pair can collide.
  it('never groups songs that have no source key', () => {
    const ids = duplicateSourceKeyIds([song('a', null, null), song('b', null, null)]);

    expect(ids.size).toBe(0);
  });

  it('separates the same key under different providers', () => {
    const ids = duplicateSourceKeyIds([song('a', 'bilibili', 'X:1'), song('b', 'kugou', 'X:1')]);

    expect(ids.size).toBe(0);
  });
});
