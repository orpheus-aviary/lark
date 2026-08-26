// Criterion 115 (N7e). A switch is one atomic line in one file, and what is on
// trial is everything it does NOT do: it moves nothing, it does not disturb
// the library this process is serving, and it refuses to point at a workspace
// that is not there.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWorkspaceIndex, writeWorkspaceIndex } from './config/workspaces.js';
import { createDatabase } from './db/index.js';
import * as paths from './paths.js';
import {
  DEFAULT_WORKSPACE_INDEX,
  WORKSPACE_LOCAL,
  computeWorkspaceId,
  withWorkspaceEntry,
} from './portable/index.js';
import { listWorkspaceIds, listWorkspaces } from './workspace-list.js';
import { hasWorkspaceIndex, switchWorkspace } from './workspace-switch.js';

const A = computeWorkspaceId('srv', 'usr-a');
const B = computeWorkspaceId('srv', 'usr-b');

let nest: string;
let lark: string;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-switch-'));
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

/** A real library for `id`, which is what the switch gate insists on. */
function materialise(id: string, songs: string[] = []): void {
  const root = paths.workspacePaths(id).root;
  mkdirSync(root, { recursive: true });
  const { sqlite } = createDatabase({ dbPath: join(root, 'songs.db') });
  songs.forEach((name, index) => {
    sqlite
      .prepare(
        `INSERT INTO songs (id, name, artist, file_origin, created_at, updated_at)
         VALUES (?, ?, '某人', 'downloaded', ?, ?)`,
      )
      .run(`1111111${index}-2222-4333-8444-555555555555`, name, index, index);
  });
  sqlite.close();
}

describe('pointing this device somewhere else', () => {
  beforeEach(() => materialise(A));

  it('writes one line and changes nothing else', () => {
    materialise(WORKSPACE_LOCAL, ['第一首']);
    const result = switchWorkspace(A);

    expect(result).toEqual({ id: A, previous: WORKSPACE_LOCAL, changed: true });
    expect(readWorkspaceIndex(paths.workspacesPath()).active).toBe(A);
    // Nothing moved: both libraries are exactly where they were.
    expect(existsSync(join(lark, 'songs.db'))).toBe(true);
    expect(existsSync(paths.workspacePaths(A).db)).toBe(true);
  });

  it('keeps the decoration it did not come to change', () => {
    writeWorkspaceIndex(
      withWorkspaceEntry(DEFAULT_WORKSPACE_INDEX, A, {
        label: '我的账号',
        server_url: 'https://x',
      }),
      paths.workspacesPath(),
    );
    paths.invalidateActiveWorkspace();
    switchWorkspace(A);
    expect(readWorkspaceIndex(paths.workspacesPath()).entries[A]).toEqual({
      label: '我的账号',
      server_url: 'https://x',
    });
  });

  it('says so when there was nothing to do', () => {
    expect(switchWorkspace(WORKSPACE_LOCAL)).toEqual({
      id: WORKSPACE_LOCAL,
      previous: WORKSPACE_LOCAL,
      changed: false,
    });
    // A no-op writes no file at all, so a device that never switched still
    // has a nest byte-identical to a 0.3.0 one.
    expect(hasWorkspaceIndex()).toBe(false);
  });

  it('is finished the moment the file lands — killing it after costs nothing', () => {
    switchWorkspace(A);
    // Everything a restart needs is in the index; nothing else was in flight.
    paths.invalidateActiveWorkspace();
    expect(paths.resolveActiveWorkspace()).toEqual({ id: A, requested: A, fellBack: false });
  });

  it('can always go back to local', () => {
    switchWorkspace(A);
    expect(switchWorkspace(WORKSPACE_LOCAL).changed).toBe(true);
    expect(readWorkspaceIndex(paths.workspacesPath()).active).toBe(WORKSPACE_LOCAL);
  });
});

describe('what it refuses', () => {
  it('will not point at a workspace that has no library', () => {
    // 🔴 The failure this prevents is the worst one available: the gate would
    // fall back to `local`, so the switch would look like it worked and then
    // show an empty library.
    expect(() => switchWorkspace(A)).toThrow(/prepare it first/);
    expect(hasWorkspaceIndex()).toBe(false);
  });

  it('will not point at something that is not a workspace id', () => {
    for (const bad of ['', 'Local', '../elsewhere']) {
      expect(() => switchWorkspace(bad)).toThrow();
    }
  });
});

describe('the list a switcher shows', () => {
  it('is local plus every workspace with a library on disk', () => {
    materialise(A);
    materialise(B);
    // A half-built one, which names no workspace and must not appear.
    mkdirSync(join(paths.librariesDir(), `.incoming-${A}`), { recursive: true });
    expect(listWorkspaceIds()).toEqual([WORKSPACE_LOCAL, ...[A, B].sort()]);
  });

  it('is local alone on a device that has never logged in', () => {
    expect(listWorkspaceIds()).toEqual([WORKSPACE_LOCAL]);
  });

  it('says which one this device opens, and what is in each', () => {
    materialise(WORKSPACE_LOCAL, ['第一首', '第二首']);
    materialise(A, ['另一首']);
    switchWorkspace(A);

    const index = withWorkspaceEntry(readWorkspaceIndex(paths.workspacesPath()), A, {
      label: 'a@example.test',
      server_url: 'https://sync.example.test',
    });
    const rows = listWorkspaces(index);

    expect(rows).toEqual([
      { id: WORKSPACE_LOCAL, label: '', server_url: '', active: false, songs: 2, playlists: 0 },
      {
        id: A,
        label: 'a@example.test',
        server_url: 'https://sync.example.test',
        active: true,
        songs: 1,
        playlists: 0,
      },
    ]);
  });

  it('survives a workspace whose library is not one', () => {
    const root = paths.workspacePaths(A).root;
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'songs.db'), 'not a database');
    // It is listed — the disk is the register — and simply has nothing in it.
    expect(() => listWorkspaces(DEFAULT_WORKSPACE_INDEX)).not.toThrow();
  });
});
