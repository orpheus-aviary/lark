import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PayloadValidationError, UnknownChangeError, parseChange } from './index.js';

const SONG_ID = randomUUID();
const PLAYLIST_ID = randomUUID();
const MEMBER_ID = `${PLAYLIST_ID}:${SONG_ID}`;

const songPayload = (overrides: Record<string, unknown> = {}) => ({
  name: '歌',
  artist: '手',
  source_url: 'https://www.bilibili.com/video/BV1x',
  source_provider: 'bilibili',
  source_key: 'BV1x:99',
  lyrics_offset: -0.5,
  duration: 200.5,
  created_at_ms: 1000,
  updated_at_ms: 2000,
  lww_counter: 3,
  ...overrides,
});

const parseSong = (op: string, payload: unknown) =>
  parseChange({ entity_type: 'song', entity_id: SONG_ID, op, payload });

describe('song changes', () => {
  it('accepts a full put and normalizes the source triple', () => {
    const parsed = parseSong('create', songPayload());
    expect(parsed).toEqual({
      entityType: 'song',
      op: 'create',
      payload: songPayload(),
    });
  });

  it('ignores fields it does not know', () => {
    // A peer on a newer build must not have its changes rejected wholesale —
    // that is a permanent divergence between two libraries that both work.
    const parsed = parseSong('update', songPayload({ colour: 'blue' }));
    expect(parsed.payload).not.toHaveProperty('colour');
  });

  it.each([
    ['a missing field', songPayload({ duration: undefined })],
    ['a wrong type', songPayload({ name: 42 })],
    ['an empty name', songPayload({ name: '' })],
    ['a negative duration', songPayload({ duration: -1 })],
    ['an unsafe integer timestamp', songPayload({ updated_at_ms: 2 ** 60 })],
    ['a non-finite offset', songPayload({ lyrics_offset: Number.POSITIVE_INFINITY })],
    ['an over-long name', songPayload({ name: 'x'.repeat(501) })],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseSong('create', payload)).toThrow(PayloadValidationError);
  });

  it.each([
    ['half a source pair', songPayload({ source_key: null })],
    ['an unknown provider', songPayload({ source_provider: 'youtube', source_key: 'abc:1' })],
    ['a malformed bilibili key', songPayload({ source_key: 'not-a-key' })],
  ])('rejects %s through the same rule the local API uses', (_label, payload) => {
    expect(() => parseSong('create', payload)).toThrow(PayloadValidationError);
  });

  it('accepts a url-only song and a bare-key song', () => {
    expect(() =>
      parseSong('create', songPayload({ source_provider: null, source_key: null })),
    ).not.toThrow();
    expect(() => parseSong('create', songPayload({ source_url: null }))).not.toThrow();
  });

  it('takes a tombstone as just the key', () => {
    expect(parseSong('delete', { updated_at_ms: 5, lww_counter: 1 })).toEqual({
      entityType: 'song',
      op: 'delete',
      payload: { updated_at_ms: 5, lww_counter: 1 },
    });
  });

  it('takes lyrics ops, including an empty document', () => {
    expect(parseSong('set_lyrics', { lrc: '' }).payload).toEqual({ lrc: '' });
    expect(parseSong('clear_lyrics', {}).payload).toEqual({});
    expect(() => parseSong('clear_lyrics', 'nope')).toThrow(PayloadValidationError);
  });
});

describe('playlist changes', () => {
  const parsePlaylist = (op: string, payload: unknown) =>
    parseChange({ entity_type: 'playlist', entity_id: PLAYLIST_ID, op, payload });

  it('accepts a put and a reorder', () => {
    expect(
      parsePlaylist('create', {
        name: '单',
        created_at_ms: 1,
        updated_at_ms: 2,
        lww_counter: 0,
      }).payload,
    ).toEqual({ name: '单', created_at_ms: 1, updated_at_ms: 2, lww_counter: 0 });

    expect(parsePlaylist('reorder', { song_ids: [SONG_ID] }).payload).toEqual({
      song_ids: [SONG_ID],
    });
  });

  it('rejects a reorder carrying anything that is not a song id', () => {
    expect(() => parsePlaylist('reorder', { song_ids: [SONG_ID, 'nope'] })).toThrow(
      PayloadValidationError,
    );
    expect(() => parsePlaylist('reorder', { song_ids: 'all' })).toThrow(PayloadValidationError);
  });
});

describe('membership changes', () => {
  const memberPayload = (overrides: Record<string, unknown> = {}) => ({
    playlist_id: PLAYLIST_ID,
    song_id: SONG_ID,
    added_at_ms: 10,
    updated_at_ms: 20,
    lww_counter: 0,
    ...overrides,
  });
  const parseMember = (op: string, payload: unknown, entityId = MEMBER_ID) =>
    parseChange({ entity_type: 'playlist_song', entity_id: entityId, op, payload });

  it('accepts a create that agrees with its composite id', () => {
    expect(parseMember('create', memberPayload()).payload).toEqual(memberPayload());
  });

  it('carries no rank on the put (R4-2)', () => {
    // rank travels on set_rank alone; a rank here would be a second channel
    // that the emitting device never replays.
    const parsed = parseMember('create', memberPayload({ rank: 2048 }));
    expect(parsed.payload).not.toHaveProperty('rank');
  });

  it('rejects a create whose payload disagrees with the entity id', () => {
    expect(() => parseMember('create', memberPayload({ song_id: randomUUID() }))).toThrow(
      PayloadValidationError,
    );
  });

  it('rejects a malformed composite id outright', () => {
    expect(() => parseMember('set_rank', { rank: 1 }, `${PLAYLIST_ID}:nope`)).toThrow(
      UnknownChangeError,
    );
    expect(() => parseMember('set_rank', { rank: 1 }, PLAYLIST_ID)).toThrow(UnknownChangeError);
    expect(() => parseMember('set_rank', { rank: 1 }, `${MEMBER_ID}:${SONG_ID}`)).toThrow(
      UnknownChangeError,
    );
  });

  it('takes a rank as a real, not an integer', () => {
    expect(parseMember('set_rank', { rank: 1536.5 }).payload).toEqual({ rank: 1536.5 });
    expect(() => parseMember('set_rank', { rank: 'last' })).toThrow(PayloadValidationError);
  });
});

describe('changes this build has no concept of', () => {
  it.each([
    ['an unknown entity type', { entity_type: 'lyrics', entity_id: SONG_ID, op: 'create' }],
    ['an unknown op', { entity_type: 'song', entity_id: SONG_ID, op: 'archive' }],
    [
      'an op from the wrong entity',
      { entity_type: 'playlist', entity_id: PLAYLIST_ID, op: 'set_lyrics' },
    ],
    ['a non-uuid entity id', { entity_type: 'song', entity_id: '../etc', op: 'create' }],
  ])('reports %s separately from a bad payload', (_label, change) => {
    // The distinction matters downstream: a bad payload is a peer bug, an
    // unknown change means "this device is behind".
    expect(() => parseChange({ ...change, payload: {} })).toThrow(UnknownChangeError);
  });
});
