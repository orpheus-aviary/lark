import type { PlayerStatusResponse } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import type { CliError } from '../lib/errors.js';
import { fakeContext, playlist, song } from '../testing/fake-backend.js';
import { type FakeSpawn, fakeSpawn, virtualClock } from '../testing/fake-child.js';
import type { GuiDeps } from './gui.js';
import {
  assertPlayShape,
  playOptionsFrom,
  runMode,
  runNowPlaying,
  runPlay,
  runPlayerControl,
  runSeek,
} from './player.js';

const SONG_ID = '11111111-2222-4333-8444-555555555555';
const PLAYLIST_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const status = (overrides: Partial<PlayerStatusResponse> = {}): PlayerStatusResponse => ({
  gui_online: true,
  player: null,
  reported_at: null,
  ...overrides,
});

const guiDeps = (spawn: FakeSpawn): GuiDeps => ({
  ...virtualClock(),
  spawnImpl: spawn.impl,
  command: () => ({ command: 'electron', args: ['gui'] }),
  waitMs: 100,
  pollMs: 10,
});

async function caught(fn: () => Promise<unknown>): Promise<CliError | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as CliError;
  }
}

describe('play', () => {
  it('refuses to guess what to play, without probing anything', () => {
    expect(() => assertPlayShape(undefined, {})).toThrow();
  });

  it('reads --no-launch under the name commander stores it as', () => {
    // Regression (T5 实测): commander turns `--no-launch` into `launch: false`,
    // never `noLaunch: true`. Reading it under the declared name left the flag
    // silently inert — and `lark play --no-launch` opened a real window.
    expect(playOptionsFrom({}).noLaunch).toBe(false);
    expect(playOptionsFrom({ launch: false }).noLaunch).toBe(true);
    expect(playOptionsFrom({ playlist: '深夜', launch: false })).toEqual({
      playlist: '深夜',
      noLaunch: true,
    });
  });

  it('resolves a song by name and sends `play`', async () => {
    const ctx = fakeContext({
      songs: [song({ id: SONG_ID, name: '晴天' })],
      playerStatus: status(),
    });
    await runPlay(ctx, '晴天', {});

    expect(ctx.backend.argsOf('playerCommand')).toEqual(['play', { song_id: SONG_ID }]);
    expect(ctx.streams.stdout).toEqual(['✓ 已开始播放']);
  });

  it('sends `play-playlist` for --playlist, and starts at a song when given one', async () => {
    const ctx = fakeContext({
      songs: [song({ id: SONG_ID, name: '晴天' })],
      playlists: [playlist({ id: PLAYLIST_ID, name: '深夜' })],
      playerStatus: status(),
    });
    await runPlay(ctx, '晴天', { playlist: '深夜' });

    expect(ctx.backend.argsOf('playerCommand')).toEqual([
      'play-playlist',
      { playlist_id: PLAYLIST_ID, song_id: SONG_ID },
    ]);
  });

  it('accepts the virtual all playlist', async () => {
    const ctx = fakeContext({ playerStatus: status() });
    await runPlay(ctx, undefined, { playlist: 'all' });

    expect(ctx.backend.argsOf('playerCommand')).toEqual(['play-playlist', { playlist_id: 'all' }]);
  });

  it('starts a GUI when none is registered', async () => {
    const spawn = fakeSpawn();
    const ctx = fakeContext({
      songs: [song({ id: SONG_ID })],
      playerStatuses: [status({ gui_online: false }), status({ gui_online: true })],
    });
    await runPlay(ctx, SONG_ID, {}, guiDeps(spawn));

    expect(spawn.children).toHaveLength(1);
    expect(ctx.backend.names()).toContain('playerCommand');
  });

  it('--no-launch spawns nothing and reports the GUI as offline', async () => {
    const spawn = fakeSpawn();
    const ctx = fakeContext({
      songs: [song({ id: SONG_ID })],
      playerStatus: status({ gui_online: false }),
    });

    const err = await caught(() => runPlay(ctx, SONG_ID, { noLaunch: true }, guiDeps(spawn)));
    expect(err?.code).toBe('GUI_OFFLINE');
    expect(spawn.children).toHaveLength(0);
    expect(ctx.backend.names()).not.toContain('playerCommand');
  });
});

describe('the transport controls', () => {
  it.each([
    ['pause', '✓ 已暂停'],
    ['resume', '✓ 已继续'],
    ['next', '✓ 已切到下一首'],
    ['prev', '✓ 已切到上一首'],
  ] as const)('%s sends an empty body and never starts a GUI', async (command, line) => {
    // Booting a window in order to pause silence is not a convenience.
    const ctx = fakeContext({ playerStatus: status({ gui_online: false }) });
    await runPlayerControl(ctx, command);

    expect(ctx.backend.names()).toEqual(['playerCommand']);
    expect(ctx.backend.argsOf('playerCommand')).toEqual([command, {}]);
    expect(ctx.streams.stdout).toEqual([line]);
  });

  it('seek takes seconds, and rejects nonsense locally', async () => {
    const ctx = fakeContext();
    await runSeek(ctx, '42.5');
    expect(ctx.backend.argsOf('playerCommand')).toEqual(['seek', { position: 42.5 }]);

    for (const bad of ['abc', '-1']) {
      const fresh = fakeContext();
      expect((await caught(() => runSeek(fresh, bad)))?.code).toBe('USAGE_ERROR');
      expect(fresh.backend.names()).toEqual([]);
    }
  });

  it('mode only accepts the four play modes', async () => {
    const ctx = fakeContext();
    await runMode(ctx, 'shuffle');
    expect(ctx.backend.argsOf('playerCommand')).toEqual(['mode', { mode: 'shuffle' }]);

    const fresh = fakeContext();
    expect((await caught(() => runMode(fresh, 'random')))?.code).toBe('USAGE_ERROR');
    expect(fresh.backend.names()).toEqual([]);
  });
});

describe('now-playing', () => {
  it('reports the current song without starting anything', async () => {
    const ctx = fakeContext({
      playerStatus: status({
        player: {
          current_song: { id: SONG_ID, name: '晴天', artist: '周杰伦' },
          is_playing: true,
          current_time: 65,
          duration: 269,
          play_mode: 'sequential',
          playlist_id: null,
        },
      }),
    });
    await runNowPlaying(ctx);

    expect(ctx.backend.names()).toEqual(['playerStatus']);
    expect(ctx.streams.stdout[0]).toContain('晴天');
    expect(ctx.streams.stdout[1]).toContain('1:05');
  });

  it('says the GUI is offline rather than opening one', async () => {
    const ctx = fakeContext({ playerStatus: status({ gui_online: false }) });
    await runNowPlaying(ctx);

    expect(ctx.streams.stdout[0]).toContain('没有在线');
  });

  it('distinguishes "online but idle" from "offline"', async () => {
    const ctx = fakeContext({ playerStatus: status() });
    await runNowPlaying(ctx);

    expect(ctx.streams.stdout[0]).toContain('还没有在播放');
  });
});
