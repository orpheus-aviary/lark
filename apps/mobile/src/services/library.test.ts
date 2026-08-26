// Which files this phone is allowed to delete (N4g-1, criteria 37 and 38).
//
// `createCacheOptions` is three predicates and a number, and everything about
// eviction that can go WRONG in a way somebody notices runs through them: the
// song that was playing when the drain started, the file that landed a second
// ago, the download that is halfway through writing one. core's `runEviction`
// re-asks all three inside its critical section (M5-5), so an answer that is
// wrong here is wrong at the moment of the unlink.
//
// The limit's storage shape is core's (`portable/cache-limit.test.ts`,
// criterion 50); what is on trial here is that this host reads it at all, per
// call, in bytes — from the DEVICE's settings since N7a, not from the library.

import { type DeviceSettingsPort, MIB } from '@lark/core/portable';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCacheOptions } from './library';

/** `device.json`, as much of it as `readCacheLimitMb` touches. */
let stored: string | undefined;
let currentSongId: string | null;
let leased: Set<string>;
let pending: Set<string>;
let reads: number;

const settings: DeviceSettingsPort = {
  get: () => {
    reads += 1;
    return stored;
  },
  set: () => {
    throw new Error('the read path must not write');
  },
};

const options = () =>
  createCacheOptions({
    settings,
    currentSongId: () => currentSongId,
    hasLease: (songId) => leased.has(songId),
    pendingFileSongIds: () => pending,
  });

beforeEach(() => {
  stored = undefined;
  currentSongId = null;
  leased = new Set();
  pending = new Set();
  reads = 0;
});

describe('the limit', () => {
  it('is unlimited when nobody has set one', () => {
    expect(options().limitBytes).toBe(0);
  });

  it('is read in MiB and answered in bytes', () => {
    stored = '512';
    expect(options().limitBytes).toBe(512 * MIB);
  });

  it('is read afresh on every call — a settings page changes it mid-process', () => {
    stored = '100';
    expect(options().limitBytes).toBe(100 * MIB);
    stored = '200';
    expect(options().limitBytes).toBe(200 * MIB);
    expect(reads).toBe(2);
  });
});

describe('who may not be deleted', () => {
  it('nobody, when nothing is playing and nothing is being written', () => {
    const { isExcluded } = options();
    expect(isExcluded('a')).toBe(false);
  });

  it('the song the player is on', () => {
    currentSongId = 'a';
    expect(options().isExcluded('a')).toBe(true);
    expect(options().isExcluded('b')).toBe(false);
  });

  it('a song holding an ensure lease — the file landed, the play has not started', () => {
    leased.add('a');
    expect(options().isExcluded('a')).toBe(true);
  });

  it('a song a live task is about to write a file for', () => {
    pending.add('a');
    expect(options().isExcluded('a')).toBe(true);
  });

  it('re-asks every source per call, because a drain re-checks before it unlinks', () => {
    const { isExcluded } = options();
    expect(isExcluded('a')).toBe(false);
    // Everything that can change during the one await in `runEviction`'s loop:
    // the user tapped a row, and a redownload started.
    currentSongId = 'a';
    pending.add('b');
    expect(isExcluded('a')).toBe(true);
    expect(isExcluded('b')).toBe(true);
  });
});

describe('streams', () => {
  it('are always zero, and honestly so', () => {
    // Not a placeholder: the desktop counts open `GET /audio` responses because
    // its renderer plays over HTTP. ExoPlayer opens the file itself.
    const { streamCount } = options();
    expect(streamCount('a')).toBe(0);
  });
});
