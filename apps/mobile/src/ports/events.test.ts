// Which announcement reaches which screen (N5c).
//
// The switch this exercises has twelve arms, no observable effect on a phone,
// and exactly one wrong answer per arm. A device can only ever show the sum of
// them — "the list did not refresh" says nothing about whether the event was
// mapped to the wrong sink, dropped, or never emitted — so the mapping is
// settled here and the device is asked about the round, not the fan-out.
//
// The compile-time half is in the file itself (`event satisfies never`): a new
// member of `LarkEvent` breaks the build rather than being dropped silently.
// What is left for runtime is the part types cannot check — that each arm goes
// to the sink a person would expect.

import type { LarkEvent } from '@lark/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { type EventSinks, createEvents } from './events';

let library = 0;
let sync = 0;
let lyrics: string[] = [];

const sinks: EventSinks = {
  libraryChanged: () => {
    library += 1;
  },
  syncChanged: () => {
    sync += 1;
  },
  lyricsChanged: (songId) => {
    lyrics.push(songId);
  },
};

const emit = (event: LarkEvent) => createEvents(sinks).emit(event);

beforeEach(() => {
  library = 0;
  sync = 0;
  lyrics = [];
});

describe('what a pull changed', () => {
  // The coordinator announces these with the SAME types the local write paths
  // use, so the listeners that already exist reconcile themselves.
  it.each<LarkEvent>([
    { type: 'songs:changed' },
    { type: 'playlists:changed' },
    { type: 'cache:evicted', song_id: '11111111-1111-4111-8111-111111111111' },
  ])('$type refreshes the library and nothing else', (event) => {
    emit(event);
    expect(library).toBe(1);
    expect(sync).toBe(0);
    expect(lyrics).toEqual([]);
  });

  // Both halves, and the second one was N5c's known gap: the player reads
  // lyrics exactly once, when a song starts, so a peer's edit to the song
  // under the needle would otherwise show up only the next time it played.
  it('lyrics:changed refreshes the list AND the words on the player', () => {
    emit({ type: 'lyrics:changed', song_id: 'song-1' });
    expect(library).toBe(1);
    expect(lyrics).toEqual(['song-1']);
    expect(sync).toBe(0);
  });
});

describe('what sync is doing', () => {
  it.each<LarkEvent>([
    { type: 'sync:status_changed', state: 'syncing' },
    { type: 'conflicts:changed', count: 2 },
    // Nothing was lost, but a directory nobody is told about is a directory
    // nobody looks in — and `quarantined_count` rides on the status, so the
    // refresh IS the notice.
    { type: 'sync:file_quarantined', song_id: '11111111-1111-4111-8111-111111111111' },
  ])('$type refreshes sync and does NOT rebuild the library', (event) => {
    emit(event);
    expect(sync).toBe(1);
    expect(library).toBe(0);
  });
});

describe('the daemon-only half of the union', () => {
  // Not "unhandled" — deliberately inert. `hello` belongs to an SSE stream this
  // app does not open, `player:command` is unicast to a desktop GUI, and the
  // download family reaches the hub through `EngineCallbacks` instead. A
  // regression here would be a download event that quietly rebuilds the whole
  // library list on every progress tick.
  it.each<LarkEvent>([
    { type: 'hello', server_time: 0 },
    {
      type: 'download:status',
      task_id: 't',
      state: 'running',
      stage: 'downloading',
      revision: 1,
      received_bytes: 0,
      total_bytes: null,
      title: null,
      artist: null,
    },
    { type: 'download:complete', task_id: 't', song_id: 's' },
    { type: 'download:error', task_id: 't', error_code: 'X', message: 'm' },
    { type: 'download:cancelled', task_id: 't' },
    { type: 'download:batches-changed', batch_id: 'b' },
  ])('$type touches neither sink', (event) => {
    emit(event);
    expect(library).toBe(0);
    expect(sync).toBe(0);
  });
});

describe('one bus, many events', () => {
  it('counts every emit rather than collapsing them', () => {
    const bus = createEvents(sinks);
    bus.emit({ type: 'songs:changed' });
    bus.emit({ type: 'playlists:changed' });
    bus.emit({ type: 'sync:status_changed', state: 'idle' });
    expect(library).toBe(2);
    expect(sync).toBe(1);
  });
});
