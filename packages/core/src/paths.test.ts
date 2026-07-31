import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as paths from './paths.js';

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
