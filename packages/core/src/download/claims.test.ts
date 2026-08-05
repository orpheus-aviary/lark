// The conflict matrix, stated explicitly. Every cell here is a real scenario:
// "delete a song mid-download", "fetch lyrics while the audio downloads",
// "edit the source URL of a song that is being replaced".

import { describe, expect, it } from 'vitest';
import { SongBusyError } from '../errors.js';
import { CLAIM_TYPES, ClaimRegistry, type ClaimType } from './claims.js';

const SONG = 'song-1';
const OTHER = 'song-2';

describe('conflict matrix', () => {
  const blocks = (held: ClaimType, wanted: ClaimType): boolean => {
    const registry = new ClaimRegistry();
    registry.acquire(SONG, held, 'owner-a');
    try {
      registry.acquire(SONG, wanted, 'owner-b');
      return false;
    } catch {
      return true;
    }
  };

  it('serialises same-type writers', () => {
    expect(blocks('file', 'file')).toBe(true);
    expect(blocks('lyrics', 'lyrics')).toBe(true);
  });

  // Fetching lyrics says nothing about replacing audio; making these exclusive
  // would serialise the two halves of every download for no reason.
  it('lets file and lyrics run together', () => {
    expect(blocks('file', 'lyrics')).toBe(false);
    expect(blocks('lyrics', 'file')).toBe(false);
  });

  it('makes exclusive conflict with everything, in both directions', () => {
    for (const other of CLAIM_TYPES) {
      expect(blocks('exclusive', other)).toBe(true);
      expect(blocks(other, 'exclusive')).toBe(true);
    }
  });

  it('scopes claims to one song', () => {
    const registry = new ClaimRegistry();
    registry.acquire(SONG, 'exclusive', 'owner-a');
    expect(() => registry.acquire(OTHER, 'exclusive', 'owner-b')).not.toThrow();
  });
});

describe('ownership', () => {
  // Queue promotion: a queued task reserves the song, then the running task
  // takes the real claim under the same id. Without this every task would
  // block on its own reservation the moment it started (fifth review ③).
  it('never blocks an owner against itself', () => {
    const registry = new ClaimRegistry();
    registry.acquire(SONG, 'file', 'task-1');
    expect(() => registry.acquire(SONG, 'file', 'task-1')).not.toThrow();
    expect(() => registry.acquire(SONG, 'exclusive', 'task-1')).not.toThrow();
  });

  it('still blocks a different owner while the first holds it', () => {
    const registry = new ClaimRegistry();
    registry.acquire(SONG, 'file', 'task-1');
    expect(() => registry.acquire(SONG, 'file', 'task-2')).toThrow(SongBusyError);
  });

  it('names the blocking holder in the error', () => {
    const registry = new ClaimRegistry();
    registry.acquire(SONG, 'exclusive', 'route-delete');
    expect(() => registry.acquire(SONG, 'file', 'task-9')).toThrow(
      /exclusive held by route-delete/,
    );
  });

  it('frees the song once released', () => {
    const registry = new ClaimRegistry();
    const token = registry.acquire(SONG, 'file', 'task-1');
    registry.release(token);
    expect(() => registry.acquire(SONG, 'file', 'task-2')).not.toThrow();
    expect(registry.size).toBe(1); // held by task-2 now
  });

  it('treats a double release as a no-op', () => {
    const registry = new ClaimRegistry();
    const token = registry.acquire(SONG, 'file', 'task-1');
    registry.release(token);
    registry.release(token);
    expect(registry.describe(SONG)).toEqual([]);
  });

  // The finally path: after an unexpected throw a task cannot be trusted to
  // know which of its claims it still holds.
  it('releases everything one owner holds at once', () => {
    const registry = new ClaimRegistry();
    registry.acquire(SONG, 'file', 'task-1');
    registry.acquire(OTHER, 'lyrics', 'task-1');
    registry.acquire(SONG, 'lyrics', 'task-2');

    registry.releaseOwner('task-1');
    expect(registry.describe(SONG)).toEqual([{ type: 'lyrics', owner: 'task-2' }]);
    expect(registry.describe(OTHER)).toEqual([]);
  });

  it('leaves other owners alone when one releases', () => {
    const registry = new ClaimRegistry();
    registry.acquire(SONG, 'file', 'task-1');
    registry.acquire(SONG, 'lyrics', 'task-2');
    registry.releaseOwner('task-3');
    expect(registry.describe(SONG)).toHaveLength(2);
  });
});
