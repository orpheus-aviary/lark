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
