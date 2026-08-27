import type { SongData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { songToPrefetch } from './prefetch';

const song = (id: string, patch: Partial<SongData> = {}): SongData =>
  ({
    id,
    name: id,
    artist: '',
    source_url: null,
    source_provider: 'bilibili',
    source_key: 'BV1:1',
    file_origin: 'downloaded',
    lyrics_offset: 0,
    duration: 200,
    pinned: false,
    created_at: 0,
    updated_at: 0,
    has_file: true,
    ...patch,
  }) as SongData;

const gapped = [song('a'), song('b', { has_file: false }), song('c')];

describe('songToPrefetch', () => {
  it('is the song that will actually play next', () => {
    // 🔴 Worked out by asking `decideNext`, not by walking the list here: two
    // answers to "what is next" eventually fetch one song and play another,
    // and the symptom is the wait this exists to remove.
    expect(
      songToPrefetch({ songs: gapped, currentId: 'a', mode: 'sequential', enabled: true })?.id,
    ).toBe('b');
  });

  it('is nothing when the next song is already here', () => {
    expect(
      songToPrefetch({ songs: gapped, currentId: 'b', mode: 'sequential', enabled: true }),
    ).toBeNull();
  });

  it('is nothing at the end of a list that does not wrap', () => {
    expect(
      songToPrefetch({ songs: gapped, currentId: 'c', mode: 'sequential', enabled: true }),
    ).toBeNull();
  });

  it('wraps when the list does', () => {
    const wrapping = [song('a', { has_file: false }), song('b')];
    expect(
      songToPrefetch({ songs: wrapping, currentId: 'b', mode: 'repeat-all', enabled: true })?.id,
    ).toBe('a');
  });

  it('is nothing under shuffle — the next song is drawn when this one ends', () => {
    expect(
      songToPrefetch({ songs: gapped, currentId: 'a', mode: 'shuffle', enabled: true }),
    ).toBeNull();
  });

  it('is nothing under repeat-one — there is no next song', () => {
    expect(
      songToPrefetch({ songs: gapped, currentId: 'a', mode: 'repeat-one', enabled: true }),
    ).toBeNull();
  });

  it('is nothing when the setting is off', () => {
    expect(
      songToPrefetch({ songs: gapped, currentId: 'a', mode: 'sequential', enabled: false }),
    ).toBeNull();
  });

  it('is nothing for a song with nowhere to fetch it from', () => {
    const imported = [song('a'), song('mine', { has_file: false, source_key: null })];
    expect(
      songToPrefetch({ songs: imported, currentId: 'a', mode: 'sequential', enabled: true }),
    ).toBeNull();
  });

  it('is nothing when nothing is playing', () => {
    expect(
      songToPrefetch({ songs: gapped, currentId: null, mode: 'sequential', enabled: true }),
    ).toBeNull();
  });
});
