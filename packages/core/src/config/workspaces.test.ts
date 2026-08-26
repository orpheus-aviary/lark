// Criterion 107's desktop half (N7b): what this host does with the file, given
// that what the file MEANS is settled in `portable/workspace-index.test.ts`.
//
// Three things only this side can answer — that TOML survives a round trip
// including an id made entirely of digits, that a file this build cannot parse
// costs nothing, and that the write leaves no residue and never a half-written
// file for a reader that is deciding which library to open.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_INDEX,
  WORKSPACE_LOCAL,
  computeWorkspaceId,
  withActiveWorkspace,
  withWorkspaceEntry,
} from '../portable/index.js';
import { readWorkspaceIndex, writeWorkspaceIndex } from './workspaces.js';

let dir: string;
let path: string;
const ID = computeWorkspaceId('srv', 'usr');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-workspaces-'));
  path = join(dir, 'workspaces.toml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a device that has never switched', () => {
  it('has no file, and that is not an error', () => {
    expect(readWorkspaceIndex(path)).toEqual(DEFAULT_WORKSPACE_INDEX);
    // Reading must not create it: a read path that writes is a read path that
    // can fail on a read-only volume.
    expect(existsSync(path)).toBe(false);
  });
});

describe('round trip', () => {
  it('keeps active and the decoration', () => {
    const index = withWorkspaceEntry(withActiveWorkspace(DEFAULT_WORKSPACE_INDEX, ID), ID, {
      label: 'someone@example.test',
      server_url: 'https://sync.example.test',
    });
    writeWorkspaceIndex(index, path);
    expect(readWorkspaceIndex(path)).toEqual(index);
  });

  it('keeps an id that is all digits — a TOML bare key, not a number', () => {
    const digits = '01234567890123456789012345678901';
    const index = withWorkspaceEntry(withActiveWorkspace(DEFAULT_WORKSPACE_INDEX, digits), digits, {
      label: '',
      server_url: '',
    });
    writeWorkspaceIndex(index, path);
    const read = readWorkspaceIndex(path);
    expect(read.active).toBe(digits);
    expect(Object.keys(read.entries)).toEqual([digits]);
  });

  it('makes the directory on the way, so a fresh nest can be written to', () => {
    const nested = join(dir, 'fresh', 'workspaces.toml');
    writeWorkspaceIndex(withActiveWorkspace(DEFAULT_WORKSPACE_INDEX, ID), nested);
    expect(readWorkspaceIndex(nested).active).toBe(ID);
  });
});

describe('a file this build cannot parse', () => {
  for (const [name, text] of Object.entries({
    'not toml': 'active = = local',
    truncated: 'active = "loc',
    empty: '',
    'a toml array of tables': '[[entries]]\nlabel = "x"\n',
  })) {
    it(`reads ${name} as "this device opens its local library"`, () => {
      writeFileSync(path, text);
      expect(readWorkspaceIndex(path).active).toBe(WORKSPACE_LOCAL);
      // And leaves it exactly as it found it — repairing a file it cannot read
      // is how a downgrade eats somebody's choice.
      expect(readFileSync(path, 'utf-8')).toBe(text);
    });
  }
});

describe('the write', () => {
  it('is 0644 — it is a pointer and a label, not a token', () => {
    writeWorkspaceIndex(DEFAULT_WORKSPACE_INDEX, path);
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it('leaves no residue behind it', () => {
    writeWorkspaceIndex(DEFAULT_WORKSPACE_INDEX, path);
    writeWorkspaceIndex(withActiveWorkspace(DEFAULT_WORKSPACE_INDEX, ID), path);
    expect(readdirSync(dir)).toEqual(['workspaces.toml']);
  });

  it('replaces rather than merges — a dropped entry stays dropped', () => {
    writeWorkspaceIndex(
      withWorkspaceEntry(DEFAULT_WORKSPACE_INDEX, ID, { label: 'old', server_url: '' }),
      path,
    );
    writeWorkspaceIndex(DEFAULT_WORKSPACE_INDEX, path);
    expect(readWorkspaceIndex(path).entries).toEqual({});
  });

  it('reports a rename it could not do, and cleans up after itself', () => {
    // A directory where the file should be: the rename fails, and the temp
    // file must not be left behind for a nest backup to find.
    mkdirSync(path);
    expect(() => writeWorkspaceIndex(DEFAULT_WORKSPACE_INDEX, path)).toThrow();
    expect(readdirSync(dir)).toEqual(['workspaces.toml']);
  });
});
