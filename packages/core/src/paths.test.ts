import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as paths from './paths.js';
import { InvalidIdError } from './portable/errors.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('paths', () => {
  it('defaults to ~/orpheus-aviary-nest/lark', () => {
    vi.stubEnv('LARK_NEST_DIR', undefined);
    expect(paths.nestDir()).toBe(join(homedir(), 'orpheus-aviary-nest'));
    expect(paths.larkDir()).toBe(join(homedir(), 'orpheus-aviary-nest', 'lark'));
  });

  it('honours LARK_NEST_DIR and re-reads it on every call', () => {
    vi.stubEnv('LARK_NEST_DIR', '/tmp/nest-a');
    expect(paths.larkDir()).toBe('/tmp/nest-a/lark');
    // Re-read, not cached at import time — tests flip the env between assertions.
    vi.stubEnv('LARK_NEST_DIR', '/tmp/nest-b');
    expect(paths.larkDir()).toBe('/tmp/nest-b/lark');
  });

  it('ignores an empty override', () => {
    vi.stubEnv('LARK_NEST_DIR', '');
    expect(paths.nestDir()).toBe(join(homedir(), 'orpheus-aviary-nest'));
  });

  it('derives every artefact path from larkDir', () => {
    vi.stubEnv('LARK_NEST_DIR', '/tmp/nest');
    expect(paths.configPath()).toBe('/tmp/nest/lark/lark_config.toml');
    expect(paths.dbPath()).toBe('/tmp/nest/lark/songs.db');
    expect(paths.localTokenPath()).toBe('/tmp/nest/lark/daemon-token');
    expect(paths.pidPath()).toBe('/tmp/nest/lark/daemon.pid');
    expect(paths.logsDir()).toBe('/tmp/nest/lark/logs');
    expect(paths.larkLogPath()).toBe('/tmp/nest/lark/logs/lark.log');
    expect(paths.songsDir()).toBe('/tmp/nest/lark/songs');
  });
});

// The desktop's PathsPort (N1a). `library/lyrics.ts` delegates to this, so
// there is one implementation of "where is this song's audio" rather than two
// that agree until they don't.
describe('nodePaths', () => {
  const id = '9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001';

  it('names a song\u2019s files under songsDir', () => {
    vi.stubEnv('LARK_NEST_DIR', '/tmp/nest');
    const port = paths.nodePaths();
    expect(port.songDir(id)).toBe(`/tmp/nest/lark/songs/${id}`);
    expect(port.songAudio(id)).toBe(`/tmp/nest/lark/songs/${id}/song.m4a`);
    expect(port.songLegacyAudio(id)).toBe(`/tmp/nest/lark/songs/${id}/song.mp3`);
    expect(port.songLyrics(id)).toBe(`/tmp/nest/lark/songs/${id}/lyrics.lrc`);
  });

  it('refuses an id that is not a UUID v4, on every path (R10)', () => {
    const port = paths.nodePaths();
    for (const bad of ['../etc', 'not-a-uuid', '', `${id}/..`, id.toUpperCase()]) {
      expect(() => port.songDir(bad)).toThrow(InvalidIdError);
      expect(() => port.songAudio(bad)).toThrow(InvalidIdError);
      expect(() => port.songLegacyAudio(bad)).toThrow(InvalidIdError);
      expect(() => port.songLyrics(bad)).toThrow(InvalidIdError);
    }
  });

  it('re-reads the nest on every call, like the rest of this module', () => {
    const port = paths.nodePaths();
    vi.stubEnv('LARK_NEST_DIR', '/tmp/nest-a');
    expect(port.songDir(id)).toBe(`/tmp/nest-a/lark/songs/${id}`);
    vi.stubEnv('LARK_NEST_DIR', '/tmp/nest-b');
    expect(port.songDir(id)).toBe(`/tmp/nest-b/lark/songs/${id}`);
  });
});

describe('the workspace layout (N7b)', () => {
  const id = '0d37bfbdb385448f80a53bd8ba7e61d3';

  it('puts the device’s own files at the nest root', () => {
    vi.stubEnv('LARK_NEST_DIR', '/tmp/nest');
    expect(paths.workspacesPath()).toBe('/tmp/nest/lark/workspaces.toml');
    expect(paths.librariesDir()).toBe('/tmp/nest/lark/libraries');
  });

  it('leaves `local` exactly where the library has always been', () => {
    vi.stubEnv('LARK_NEST_DIR', '/tmp/nest');
    const local = paths.workspacePaths('local');
    // Not a coincidence to be maintained — it IS the zero-migration promise.
    expect(local.root).toBe(paths.larkDir());
    expect(local.db).toBe(paths.dbPath());
    expect(local.songs).toBe(paths.songsDir());
    expect(local.trash).toBe(paths.trashDir());
    expect(local.recoveredSongs).toBe(paths.recoveredSongsDir());
    expect(local.migrationBackup).toBe(paths.migrationBackupDir());
    expect(local.skybridgeConfig).toBe(paths.skybridgeConfigPath());
  });

  it('gives an account workspace its own everything, credentials included', () => {
    vi.stubEnv('LARK_NEST_DIR', '/tmp/nest');
    expect(paths.workspacePaths(id)).toEqual({
      root: `/tmp/nest/lark/libraries/${id}`,
      db: `/tmp/nest/lark/libraries/${id}/songs.db`,
      songs: `/tmp/nest/lark/libraries/${id}/songs`,
      trash: `/tmp/nest/lark/libraries/${id}/trash`,
      recoveredSongs: `/tmp/nest/lark/libraries/${id}/recovered-songs`,
      migrationBackup: `/tmp/nest/lark/libraries/${id}/migration-backup`,
      skybridgeConfig: `/tmp/nest/lark/libraries/${id}/skybridge.toml`,
    });
  });

  it('shares nothing between two workspaces', () => {
    vi.stubEnv('LARK_NEST_DIR', '/tmp/nest');
    const a = paths.workspacePaths(id);
    const b = paths.workspacePaths('ea7fb08b7a2dc4619ffb7c7bb38d95a2');
    for (const key of Object.keys(a) as (keyof typeof a)[]) {
      expect(a[key]).not.toBe(b[key]);
    }
  });

  it('refuses an id that is not one, before it becomes a directory', () => {
    vi.stubEnv('LARK_NEST_DIR', '/tmp/nest');
    for (const bad of ['', '..', '../../etc', 'Local', id.toUpperCase(), `${id}/..`]) {
      expect(() => paths.workspacePaths(bad)).toThrow();
    }
  });

  it('re-reads the nest on every call, like the rest of this module', () => {
    vi.stubEnv('LARK_NEST_DIR', '/tmp/nest-a');
    expect(paths.workspacePaths(id).db).toBe(`/tmp/nest-a/lark/libraries/${id}/songs.db`);
    vi.stubEnv('LARK_NEST_DIR', '/tmp/nest-b');
    expect(paths.workspacePaths(id).db).toBe(`/tmp/nest-b/lark/libraries/${id}/songs.db`);
  });
});
