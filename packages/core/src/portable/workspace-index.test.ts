// Criterion 107 (N7b). The index is the one file that can point a device at
// the wrong library, so what is on trial is where every unreadable spelling of
// it lands — and that none of them takes a workspace with it.

import { describe, expect, it } from 'vitest';
import type { StructuredLogger } from './logger.js';
import {
  DEFAULT_WORKSPACE_INDEX,
  decideActiveWorkspace,
  parseWorkspaceIndex,
  serializeWorkspaceIndex,
  withActiveWorkspace,
  withWorkspaceEntry,
} from './workspace-index.js';
import { WORKSPACE_LOCAL, computeWorkspaceId } from './workspace.js';

const ID = computeWorkspaceId('srv', 'usr');
const OTHER = computeWorkspaceId('srv', 'usr-2');

const warnings: Record<string, unknown>[] = [];
const recorder: StructuredLogger = {
  debug: () => {},
  info: () => {},
  warn: (fields) => {
    warnings.push(fields);
  },
  error: () => {},
};

describe('an index this build cannot use', () => {
  const unreadable: Record<string, unknown> = {
    undefined: undefined,
    null: null,
    'a string': 'active = local',
    'an array': [{ active: 'local' }],
    'a number': 7,
    empty: {},
    'no active': { entries: {} },
    'an active that is not a string': { active: 7 },
    'an active that is not an id': { active: 'LOCAL' },
    'an active with a traversal in it': { active: '../elsewhere' },
    'an active one hex short': { active: '0d37bfbdb385448f80a53bd8ba7e61d' },
  };

  for (const [name, value] of Object.entries(unreadable)) {
    it(`reads ${name} as "this device opens its local library"`, () => {
      expect(parseWorkspaceIndex(value).active).toBe(WORKSPACE_LOCAL);
    });
  }

  it('says so, rather than quietly opening something else', () => {
    warnings.length = 0;
    parseWorkspaceIndex({ active: 'LOCAL' }, recorder);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({ active: 'LOCAL' });
  });

  it('is exactly the default, decoration and all', () => {
    expect(parseWorkspaceIndex('nonsense')).toEqual(DEFAULT_WORKSPACE_INDEX);
    expect(DEFAULT_WORKSPACE_INDEX.active).toBe(WORKSPACE_LOCAL);
  });
});

describe('an index this build wrote', () => {
  it('reads active and the decoration back', () => {
    const index = parseWorkspaceIndex({
      active: ID,
      entries: {
        [ID]: { label: 'someone@example.test', server_url: 'https://sync.example.test' },
        [WORKSPACE_LOCAL]: { label: '本机曲库', server_url: '' },
      },
    });
    expect(index.active).toBe(ID);
    expect(index.entries[ID]).toEqual({
      label: 'someone@example.test',
      server_url: 'https://sync.example.test',
    });
    expect(index.entries[WORKSPACE_LOCAL]?.label).toBe('本机曲库');
  });

  it('round-trips through serialize', () => {
    const index = parseWorkspaceIndex({
      active: ID,
      entries: { [ID]: { label: 'a', server_url: 'b' } },
    });
    expect(parseWorkspaceIndex(serializeWorkspaceIndex(index))).toEqual(index);
  });
});

describe('decoration that cannot be read', () => {
  it('costs a name and nothing else', () => {
    const index = parseWorkspaceIndex({
      active: ID,
      entries: {
        [ID]: 'not an object',
        [OTHER]: { label: 7, server_url: null },
        'not-an-id': { label: 'x' },
      },
    });
    // The point of the whole split: `libraries/<ID>/` is still on disk and
    // still the active workspace. What was lost is a label.
    expect(index.active).toBe(ID);
    expect(index.entries[ID]).toBeUndefined();
    expect(index.entries[OTHER]).toEqual({ label: '', server_url: '' });
    expect(index.entries['not-an-id']).toBeUndefined();
  });

  it('does not let a broken entries block move active', () => {
    expect(parseWorkspaceIndex({ active: ID, entries: 'gone' }).active).toBe(ID);
  });
});

describe('which workspace a device opens', () => {
  const never = () => false;
  const always = () => true;

  it('opens local when that is what the index says, without asking the disk', () => {
    let asked = 0;
    const verdict = decideActiveWorkspace(DEFAULT_WORKSPACE_INDEX, () => {
      asked += 1;
      return true;
    });
    expect(verdict).toEqual({ id: WORKSPACE_LOCAL, requested: WORKSPACE_LOCAL, fellBack: false });
    // `local` is the nest itself: there is no separate library to look for.
    expect(asked).toBe(0);
  });

  it('opens the account workspace when its library is there', () => {
    const index = parseWorkspaceIndex({ active: ID });
    expect(decideActiveWorkspace(index, always)).toEqual({
      id: ID,
      requested: ID,
      fellBack: false,
    });
  });

  it('falls back to local when the library is not, and says so', () => {
    const index = parseWorkspaceIndex({ active: ID });
    expect(decideActiveWorkspace(index, never)).toEqual({
      id: WORKSPACE_LOCAL,
      requested: ID,
      fellBack: true,
    });
  });

  it('asks about the workspace it was told to open, and no other', () => {
    const asked: string[] = [];
    decideActiveWorkspace(parseWorkspaceIndex({ active: ID }), (id) => {
      asked.push(id);
      return false;
    });
    expect(asked).toEqual([ID]);
  });

  it('never opens something an unreadable index named', () => {
    // The parse already collapsed it to `local`; this pins that the gate
    // cannot undo that by consulting the disk.
    expect(decideActiveWorkspace(parseWorkspaceIndex('rubbish'), always).id).toBe(WORKSPACE_LOCAL);
  });
});

describe('changing it', () => {
  it('replaces active without touching the decoration', () => {
    const index = parseWorkspaceIndex({
      active: WORKSPACE_LOCAL,
      entries: { [ID]: { label: 'a', server_url: 'b' } },
    });
    const next = withActiveWorkspace(index, ID);
    expect(next.active).toBe(ID);
    expect(next.entries).toEqual(index.entries);
    // And the value it was called on is unchanged — a caller that fails to
    // write must not be left holding a switch that already happened.
    expect(index.active).toBe(WORKSPACE_LOCAL);
  });

  it('adds a name without touching active', () => {
    const next = withWorkspaceEntry(DEFAULT_WORKSPACE_INDEX, ID, {
      label: 'someone@example.test',
      server_url: 'https://sync.example.test',
    });
    expect(next.active).toBe(WORKSPACE_LOCAL);
    expect(next.entries[ID]?.label).toBe('someone@example.test');
  });

  it('refuses an id that is not one, at the boundary rather than on disk', () => {
    expect(() => withActiveWorkspace(DEFAULT_WORKSPACE_INDEX, '../elsewhere')).toThrow();
    expect(() =>
      withWorkspaceEntry(DEFAULT_WORKSPACE_INDEX, 'nope', { label: '', server_url: '' }),
    ).toThrow();
  });
});
