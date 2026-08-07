import { describe, expect, it } from 'vitest';
import { createFakeBackend, playlist, song } from '../testing/fake-backend.js';
import type { CliError } from './errors.js';
import { resolvePlaylistRef, resolveSongRef } from './resolve-ref.js';

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = '22222222-3333-4444-8555-666666666666';

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as CliError).code;
  }
}

describe('resolveSongRef', () => {
  it('passes a uuid through without a lookup', async () => {
    const backend = createFakeBackend({ songs: [] });
    expect(await resolveSongRef(backend, UUID_A)).toBe(UUID_A);
    expect(backend.names()).toEqual([]);
  });

  it('resolves a unique name', async () => {
    const backend = createFakeBackend({ songs: [song({ id: UUID_A, name: '晴天' })] });
    expect(await resolveSongRef(backend, '晴天')).toBe(UUID_A);
  });

  it('does not let a substring match win', async () => {
    // `search` is the daemon's substring filter — a PREFILTER. The exact match
    // is what decides, or "晴天" would resolve to "晴天娃娃".
    const backend = createFakeBackend({
      songs: [song({ id: UUID_A, name: '晴天娃娃' }), song({ id: UUID_B, name: '晴天' })],
    });
    expect(await resolveSongRef(backend, '晴天')).toBe(UUID_B);
  });

  it('falls back to a case-insensitive match', async () => {
    const backend = createFakeBackend({ songs: [song({ id: UUID_A, name: 'Yesterday' })] });
    expect(await resolveSongRef(backend, 'yesterday')).toBe(UUID_A);
  });

  it('reports NOT_FOUND rather than guessing', async () => {
    const backend = createFakeBackend({ songs: [] });
    expect(await codeOf(() => resolveSongRef(backend, '不存在'))).toBe('NOT_FOUND');
  });

  it('refuses to pick one of several identically-named songs', async () => {
    // R25: picking the first match is how the wrong song gets deleted.
    const backend = createFakeBackend({
      songs: [
        song({ id: UUID_A, name: '晴天', artist: '周杰伦' }),
        song({ id: UUID_B, name: '晴天', artist: '翻唱' }),
      ],
    });

    let caught: CliError | null = null;
    try {
      await resolveSongRef(backend, '晴天');
    } catch (err) {
      caught = err as CliError;
    }

    expect(caught?.code).toBe('AMBIGUOUS_SONG');
    expect(caught?.details?.candidates).toEqual([
      { id: UUID_A, name: '晴天', artist: '周杰伦' },
      { id: UUID_B, name: '晴天', artist: '翻唱' },
    ]);
  });
});

describe('resolvePlaylistRef', () => {
  it('resolves a unique name', async () => {
    const backend = createFakeBackend({ playlists: [playlist({ id: UUID_A, name: '收藏' })] });
    expect(await resolvePlaylistRef(backend, '收藏')).toBe(UUID_A);
  });

  it('accepts the virtual all only where it is allowed', async () => {
    const backend = createFakeBackend({ playlists: [] });
    expect(await resolvePlaylistRef(backend, 'all', { allowAll: true })).toBe('all');
    expect(await codeOf(() => resolvePlaylistRef(backend, 'all'))).toBe('VIRTUAL_PLAYLIST');
  });

  it('never resolves a NAME onto the virtual playlist', async () => {
    // The daemon lists `all` first and it is not a real row; only its literal
    // id selects it (R24).
    const backend = createFakeBackend({
      playlists: [playlist({ id: 'all', name: 'all' }), playlist({ id: UUID_A, name: '收藏' })],
    });
    expect(await codeOf(() => resolvePlaylistRef(backend, 'all', { allowAll: false }))).toBe(
      'VIRTUAL_PLAYLIST',
    );
    expect(await resolvePlaylistRef(backend, '收藏')).toBe(UUID_A);
  });

  it('reports ambiguity with candidates', async () => {
    const backend = createFakeBackend({
      playlists: [playlist({ id: UUID_A, name: '收藏' }), playlist({ id: UUID_B, name: '收藏' })],
    });

    let caught: CliError | null = null;
    try {
      await resolvePlaylistRef(backend, '收藏');
    } catch (err) {
      caught = err as CliError;
    }
    expect(caught?.code).toBe('AMBIGUOUS_PLAYLIST');
    expect(caught?.details?.candidates).toHaveLength(2);
  });
});
