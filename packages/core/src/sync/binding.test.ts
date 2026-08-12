import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseHandles, createDatabase } from '../db/index.js';
import { SyncBindingMismatchError } from '../errors.js';
import {
  type SyncBindingCandidate,
  assertBindingMatches,
  clearBindingInTx,
  readBinding,
  writeBindingInTx,
} from './binding.js';

let handles: DatabaseHandles;

beforeEach(() => {
  handles = createDatabase({ dbPath: ':memory:' });
});

afterEach(() => {
  handles.sqlite.close();
});

const sq = () => handles.sqlite;

const candidate: SyncBindingCandidate = {
  server_id: 'server-1',
  user_id: 'user-1',
  workspace_id: 'workspace-1',
  schema_version: 1,
};

describe('sync binding', () => {
  it('starts unbound', () => {
    expect(readBinding(sq())).toBeNull();
  });

  it('writes once and reads back', () => {
    const written = writeBindingInTx(sq(), candidate, 1700);
    expect(written).toEqual({ ...candidate, bound_at: 1700 });
    expect(readBinding(sq())).toEqual({ ...candidate, bound_at: 1700 });
  });

  it('is a singleton — a second write keeps the first row', () => {
    writeBindingInTx(sq(), candidate, 1700);
    const again = writeBindingInTx(sq(), candidate, 9999);
    expect(again.bound_at).toBe(1700);
    const rows = sq().prepare('SELECT count(*) AS n FROM sync_binding').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it.each([
    ['server_id', { ...candidate, server_id: 'other-server' }],
    ['user_id', { ...candidate, user_id: 'other-user' }],
    ['workspace_id', { ...candidate, workspace_id: 'other-workspace' }],
  ])('refuses a login that changes %s', (field, other) => {
    writeBindingInTx(sq(), candidate);
    expect(() => writeBindingInTx(sq(), other)).toThrow(SyncBindingMismatchError);
    try {
      assertBindingMatches({ ...candidate, bound_at: 1 }, other);
      expect.unreachable('should have thrown');
    } catch (err) {
      // The field is part of the answer: a wrong server is a typo, a wrong user
      // is the wrong account, a wrong workspace is a server-side re-creation.
      expect((err as SyncBindingMismatchError).field).toBe(field);
      expect((err as SyncBindingMismatchError).code).toBe('SYNC_BINDING_MISMATCH');
    }
  });

  it('does not compare schema_version — that gate runs against the workspace', () => {
    writeBindingInTx(sq(), candidate);
    expect(() => writeBindingInTx(sq(), { ...candidate, schema_version: 2 })).not.toThrow();
  });

  it('clears', () => {
    writeBindingInTx(sq(), candidate);
    clearBindingInTx(sq());
    expect(readBinding(sq())).toBeNull();
  });
});
