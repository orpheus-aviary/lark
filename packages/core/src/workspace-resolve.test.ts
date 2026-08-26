// Criterion 109 (N7c): which library a process opens, and that there is one
// answer rather than one per caller.
//
// The guard beside this (`scripts/check-workspace-chokepoint.sh`) says nobody
// may name `songs.db` outside `paths.ts`. What it cannot say is that the name
// `paths.ts` produces actually follows the index — which is this file, and the
// reason both exist.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeWorkspaceIndex } from './config/workspaces.js';
import * as paths from './paths.js';
import {
  DEFAULT_WORKSPACE_INDEX,
  WORKSPACE_LOCAL,
  computeWorkspaceId,
  withActiveWorkspace,
} from './portable/index.js';

const ID = computeWorkspaceId('srv', 'usr');

let nest: string;
let lark: string;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-resolve-'));
  lark = join(nest, 'lark');
  mkdirSync(lark, { recursive: true });
  vi.stubEnv('LARK_NEST_DIR', nest);
  paths.invalidateActiveWorkspace();
});

afterEach(() => {
  vi.unstubAllEnvs();
  paths.invalidateActiveWorkspace();
  rmSync(nest, { recursive: true, force: true });
});

/** Make `libraries/<id>/songs.db` exist, which is the gate's second question. */
const materialise = (id: string): string => {
  const dir = join(lark, 'libraries', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'songs.db'), '');
  return dir;
};

const activate = (id: string): void => {
  writeWorkspaceIndex(
    withActiveWorkspace(DEFAULT_WORKSPACE_INDEX, id),
    join(lark, 'workspaces.toml'),
  );
  paths.invalidateActiveWorkspace();
};

describe('a device that has never switched', () => {
  it('opens the library where it has always been', () => {
    expect(paths.resolveActiveWorkspace()).toEqual({
      id: WORKSPACE_LOCAL,
      requested: WORKSPACE_LOCAL,
      fellBack: false,
    });
    expect(paths.dbPath()).toBe(join(lark, 'songs.db'));
    expect(paths.songsDir()).toBe(join(lark, 'songs'));
    expect(paths.skybridgeConfigPath()).toBe(join(lark, 'skybridge.toml'));
  });
});

describe('a device that has switched', () => {
  beforeEach(() => {
    materialise(ID);
    activate(ID);
  });

  it('opens that workspace, and every path moves with it', () => {
    const root = join(lark, 'libraries', ID);
    expect(paths.resolveActiveWorkspace().id).toBe(ID);
    expect(paths.dbPath()).toBe(join(root, 'songs.db'));
    expect(paths.songsDir()).toBe(join(root, 'songs'));
    expect(paths.trashDir()).toBe(join(root, 'trash'));
    expect(paths.recoveredSongsDir()).toBe(join(root, 'recovered-songs'));
    expect(paths.migrationBackupDir()).toBe(join(root, 'migration-backup'));
    // The one that would be a real leak: a workspace must not sync with
    // another workspace's session.
    expect(paths.skybridgeConfigPath()).toBe(join(root, 'skybridge.toml'));
  });

  it('leaves the device’s own files at the nest root', () => {
    expect(paths.configPath()).toBe(join(lark, 'lark_config.toml'));
    expect(paths.localTokenPath()).toBe(join(lark, 'daemon-token'));
    expect(paths.pidPath()).toBe(join(lark, 'daemon.pid'));
    expect(paths.logsDir()).toBe(join(lark, 'logs'));
    expect(paths.workspacesPath()).toBe(join(lark, 'workspaces.toml'));
  });

  it('moves them all together — no path is left behind', () => {
    const active = paths.activeWorkspacePaths();
    for (const value of Object.values(active)) {
      expect(value.startsWith(join(lark, 'libraries', ID))).toBe(true);
    }
  });
});

describe('an index that points at a library that is not there', () => {
  it('opens local and says why, rather than creating one', () => {
    activate(ID); // no `materialise`
    const verdict = paths.resolveActiveWorkspace();
    expect(verdict).toEqual({ id: WORKSPACE_LOCAL, requested: ID, fellBack: true });
    expect(paths.dbPath()).toBe(join(lark, 'songs.db'));
    // The conservative direction: nothing was made at the missing path, so a
    // nest that comes back (an unmounted volume, a restore in progress) is
    // still the nest it was.
    expect(existsSync(join(lark, 'libraries', ID))).toBe(false);
  });

  it('logs the fall-back once, with what was asked for', () => {
    activate(ID);
    const warnings: Record<string, unknown>[] = [];
    paths.resolveActiveWorkspace({
      debug: () => {},
      info: () => {},
      warn: (fields) => {
        warnings.push(fields);
      },
      error: () => {},
    });
    expect(warnings).toEqual([{ requested: ID }]);
  });
});

describe('an index this build cannot read', () => {
  it('opens local, and leaves the file alone', () => {
    const file = join(lark, 'workspaces.toml');
    writeFileSync(file, 'active = "loc');
    paths.invalidateActiveWorkspace();
    expect(paths.resolveActiveWorkspace().id).toBe(WORKSPACE_LOCAL);
    expect(existsSync(file)).toBe(true);
  });
});

describe('the answer is settled once', () => {
  it('does not change under a running process — switching is a restart', () => {
    expect(paths.resolveActiveWorkspace().id).toBe(WORKSPACE_LOCAL);
    materialise(ID);
    writeWorkspaceIndex(
      withActiveWorkspace(DEFAULT_WORKSPACE_INDEX, ID),
      join(lark, 'workspaces.toml'),
    );
    // Deliberately NOT invalidated: a process that re-read the index mid-flight
    // would have a download engine writing into one library and a player
    // reading from another.
    expect(paths.resolveActiveWorkspace().id).toBe(WORKSPACE_LOCAL);

    paths.invalidateActiveWorkspace();
    expect(paths.resolveActiveWorkspace().id).toBe(ID);
  });

  it('is per nest, so moving LARK_NEST_DIR is not stale', () => {
    materialise(ID);
    activate(ID);
    expect(paths.resolveActiveWorkspace().id).toBe(ID);

    const other = mkdtempSync(join(tmpdir(), 'lark-resolve-b-'));
    try {
      vi.stubEnv('LARK_NEST_DIR', other);
      expect(paths.resolveActiveWorkspace().id).toBe(WORKSPACE_LOCAL);
      vi.stubEnv('LARK_NEST_DIR', nest);
      expect(paths.resolveActiveWorkspace().id).toBe(ID);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
