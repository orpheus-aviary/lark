import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { skybridgeConfigPath } from '../paths.js';
import {
  type SkybridgeCredentials,
  deleteSkybridgeCredentials,
  publicSkybridgeCredentials,
  readSkybridgeCredentials,
  stashSkybridgeCredentials,
  writeSkybridgeCredentials,
} from './skybridge.js';

let nest: string;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-skybridge-cfg-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  mkdirSync(join(nest, 'lark'), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const full: SkybridgeCredentials = {
  server: { url: 'https://sync.example.test' },
  auth: {
    user_id: 'user-1',
    email: 'someone@example.test',
    token: 'access-token-value',
    refresh_token: 'refresh-token-value',
    expires_at: 1_800_000_000_000,
  },
  device: { id: 'device-1', name: 'MacBook' },
  workspace: { id: 'workspace-1' },
};

describe('skybridge credential file', () => {
  it('round-trips every section', () => {
    writeSkybridgeCredentials(full);
    expect(readSkybridgeCredentials()).toEqual(full);
  });

  it('writes 0600 and leaves no temp file behind', () => {
    writeSkybridgeCredentials(full);
    expect(statSync(skybridgeConfigPath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(nest, 'lark'))).toEqual(['skybridge.toml']);
  });

  it('reports "not configured" for a missing file', () => {
    expect(readSkybridgeCredentials()).toBeNull();
  });

  it('reports "not configured" when the file names no server', () => {
    writeFileSync(skybridgeConfigPath(), '[auth]\ntoken = "x"\n', { mode: 0o600 });
    expect(readSkybridgeCredentials()).toBeNull();
  });

  it('throws rather than silently forgetting a session when the file is corrupt', () => {
    // A syntax error read as "logged out" would be wiped by the next write.
    writeFileSync(skybridgeConfigPath(), '[server\nurl = ', { mode: 0o600 });
    expect(() => readSkybridgeCredentials()).toThrow();
  });

  it('drops a half [auth] section instead of building a session that cannot authenticate', () => {
    writeSkybridgeCredentials(full);
    writeFileSync(
      skybridgeConfigPath(),
      '[server]\nurl = "https://sync.example.test"\n\n[auth]\ntoken = "orphan"\n',
      { mode: 0o600 },
    );
    const read = readSkybridgeCredentials();
    expect(read?.server.url).toBe('https://sync.example.test');
    expect(read?.auth).toBeUndefined();
  });

  it('keeps device and workspace across a logout-shaped rewrite', () => {
    writeSkybridgeCredentials(full);
    const { auth: _dropped, ...loggedOut } = full;
    writeSkybridgeCredentials(loggedOut);
    const read = readSkybridgeCredentials();
    expect(read?.auth).toBeUndefined();
    expect(read?.device).toEqual(full.device);
    expect(read?.workspace).toEqual(full.workspace);
  });

  it('tightens a world-readable file on read', () => {
    writeSkybridgeCredentials(full);
    chmodSync(skybridgeConfigPath(), 0o644);
    expect(readSkybridgeCredentials()).toEqual(full);
    expect(statSync(skybridgeConfigPath()).mode & 0o777).toBe(0o600);
  });

  it('never puts a secret in the public projection', () => {
    writeSkybridgeCredentials(full);
    const projection = publicSkybridgeCredentials(readSkybridgeCredentials());
    expect(JSON.stringify(projection)).not.toContain('access-token-value');
    expect(JSON.stringify(projection)).not.toContain('refresh-token-value');
    expect(projection).toMatchObject({
      server_url: 'https://sync.example.test',
      has_token: true,
      has_refresh_token: true,
      device_id: 'device-1',
      workspace_id: 'workspace-1',
    });
  });

  it('projects an unconfigured install without inventing fields', () => {
    expect(publicSkybridgeCredentials(null)).toMatchObject({
      server_url: '',
      has_token: false,
      device_id: null,
    });
  });
});

describe('stashSkybridgeCredentials', () => {
  it('puts the file back on restore', () => {
    writeSkybridgeCredentials(full);
    const stash = stashSkybridgeCredentials();
    expect(stash.existed).toBe(true);
    expect(existsSync(skybridgeConfigPath())).toBe(false);

    stash.restore();
    expect(readSkybridgeCredentials()).toEqual(full);
  });

  it('leaves nothing behind on discard', () => {
    writeSkybridgeCredentials(full);
    stashSkybridgeCredentials().discard();
    expect(existsSync(skybridgeConfigPath())).toBe(false);
    expect(readdirSync(join(nest, 'lark'))).toEqual([]);
  });

  it('restoring an absent file removes whatever the failed sequence wrote', () => {
    const stash = stashSkybridgeCredentials();
    expect(stash.existed).toBe(false);

    writeSkybridgeCredentials(full); // the half-done login
    stash.restore();
    expect(existsSync(skybridgeConfigPath())).toBe(false);
  });

  it('deleteSkybridgeCredentials reports whether there was anything to delete', () => {
    expect(deleteSkybridgeCredentials()).toBe(false);
    writeSkybridgeCredentials(full);
    expect(deleteSkybridgeCredentials()).toBe(true);
  });
});
