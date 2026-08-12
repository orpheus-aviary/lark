import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SkybridgeCredentials,
  readSkybridgeCredentials,
  writeSkybridgeCredentials,
} from '../config/skybridge.js';
import { type DatabaseHandles, createDatabase } from '../db/index.js';
import { FileOpBusyError, SyncPendingChangesError } from '../errors.js';
import { skybridgeConfigPath } from '../paths.js';
import { readBackfillGenerations } from './backfill.js';
import { writeBindingInTx } from './binding.js';
import { emitSyncChange, recordDeadLetter } from './changes.js';
import { setSkybridgeDeviceId } from './device.js';
import { writeCursor } from './engine.js';
import { FileEffectRuntime, enqueueDeleteLyrics } from './file-ops.js';
import { writeTombstone } from './tombstones.js';
import { countUnpushedChanges, unbindLibrary } from './unbind.js';

let nest: string;
let handles: DatabaseHandles;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-unbind-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  mkdirSync(join(nest, 'lark'), { recursive: true });
  handles = createDatabase({ dbPath: ':memory:' });
});

afterEach(() => {
  handles.sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const sq = () => handles.sqlite;

const credentials: SkybridgeCredentials = {
  server: { url: 'https://sync.example.test' },
  auth: { user_id: 'u', email: 'e@example.test', token: 't' },
  device: { id: 'device-1', name: 'MacBook' },
  workspace: { id: 'workspace-1' },
};

/** A bound library with history, all of it already pushed. */
function seedBoundLibrary(): void {
  writeSkybridgeCredentials(credentials);
  setSkybridgeDeviceId(sq(), 'device-1');
  sq().transaction(() => {
    writeBindingInTx(sq(), {
      server_id: 'server-1',
      user_id: 'u',
      workspace_id: 'workspace-1',
      schema_version: 1,
    });
    emitSyncChange(sq(), {
      entityType: 'song',
      entityId: randomUUID(),
      op: 'create',
      payload: {
        name: 'n',
        artist: 'a',
        source_url: null,
        source_provider: null,
        source_key: null,
        lyrics_offset: 0,
        duration: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        lww_counter: 0,
      },
    });
    writeTombstone(sq(), 'song', randomUUID(), { ms: 5, counter: 0, deviceId: 'device-1' }, 5);
    recordDeadLetter(sq(), { direction: 'in', reason: 'unknown_op', payload: '{}' });
    writeCursor(sq(), 'server-1', 'workspace-1', { pulledSeq: 12, pushedSeq: 12 });
  })();
  sq().prepare('UPDATE sync_changes SET synced_at = 100, server_seq = 1').run();
}

const counts = () => ({
  changes: (sq().prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n,
  tombstones: (sq().prepare('SELECT count(*) AS n FROM sync_tombstones').get() as { n: number }).n,
  deadLetters: (sq().prepare('SELECT count(*) AS n FROM sync_dead_letters').get() as { n: number })
    .n,
  cursors: (sq().prepare('SELECT count(*) AS n FROM sync_cursor').get() as { n: number }).n,
  binding: (sq().prepare('SELECT count(*) AS n FROM sync_binding').get() as { n: number }).n,
  skybridgeKeys: (
    sq().prepare("SELECT count(*) AS n FROM local_metadata WHERE key GLOB 'skybridge_*'").get() as {
      n: number;
    }
  ).n,
});

describe('unbindLibrary', () => {
  it('clears the sync state, the identity and the credential file', async () => {
    seedBoundLibrary();
    const before = readBackfillGenerations(sq());

    const result = await unbindLibrary({ sqlite: sq() });

    expect(counts()).toEqual({
      changes: 0,
      tombstones: 0,
      deadLetters: 0,
      cursors: 0,
      binding: 0,
      skybridgeKeys: 0,
    });
    expect(existsSync(skybridgeConfigPath())).toBe(false);
    expect(result.hadCredentials).toBe(true);
    // The next login owes a full republish, because the outbox that proved
    // anything was published is gone.
    expect(readBackfillGenerations(sq()).target).toBe(before.target + 1);
    expect(result.backfillTarget).toBe(before.target + 1);
  });

  it('keeps the local device uuid and the HLC — only the server-issued identity goes', async () => {
    seedBoundLibrary();
    const uuid = (
      sq().prepare("SELECT value FROM local_metadata WHERE key = 'device_uuid'").get() as {
        value: string;
      }
    ).value;

    await unbindLibrary({ sqlite: sq() });

    expect(
      (
        sq().prepare("SELECT value FROM local_metadata WHERE key = 'device_uuid'").get() as {
          value: string;
        }
      ).value,
    ).toBe(uuid);
  });

  it('refuses by default when unpushed changes would be lost', async () => {
    seedBoundLibrary();
    sq().prepare("UPDATE sync_changes SET synced_at = NULL WHERE op = 'create'").run();
    emitSyncChange(sq(), {
      entityType: 'song',
      entityId: randomUUID(),
      op: 'clear_lyrics',
      payload: {},
    });

    expect(countUnpushedChanges(sq())).toEqual({ total: 2, unpublishedDeletes: 1 });
    await expect(unbindLibrary({ sqlite: sq() })).rejects.toThrow(SyncPendingChangesError);
    // Refused means untouched: the credentials are still there to sync with.
    expect(readSkybridgeCredentials()).not.toBeNull();
    expect(counts().binding).toBe(1);
  });

  it('--force goes through and reports what it gave up', async () => {
    seedBoundLibrary();
    sq().prepare("UPDATE sync_changes SET synced_at = NULL WHERE op = 'create'").run();

    const result = await unbindLibrary({ sqlite: sq(), force: true });
    expect(result.discarded).toEqual({ total: 1, unpublishedDeletes: 0 });
    expect(counts().changes).toBe(0);
  });

  it('refuses while the file journal still has work queued', async () => {
    seedBoundLibrary();
    enqueueDeleteLyrics(sq(), randomUUID());

    await expect(unbindLibrary({ sqlite: sq() })).rejects.toThrow(FileOpBusyError);
    expect(readSkybridgeCredentials()).not.toBeNull();
    expect(counts().binding).toBe(1);
  });

  it('drains the journal first, then proceeds', async () => {
    seedBoundLibrary();
    enqueueDeleteLyrics(sq(), randomUUID()); // no file on disk: a no-op that clears the row
    const fileOps = new FileEffectRuntime({ sqlite: sq() });

    await unbindLibrary({ sqlite: sq(), fileOps });

    expect((sq().prepare('SELECT count(*) AS n FROM sync_file_ops').get() as { n: number }).n).toBe(
      0,
    );
    expect(counts().binding).toBe(0);
  });

  it('puts the credentials back when the database work fails', async () => {
    seedBoundLibrary();
    const sqlite = sq();
    const original = sqlite.prepare.bind(sqlite);
    const spy = vi.spyOn(sqlite, 'prepare').mockImplementation(((
      sql: string,
      ...rest: unknown[]
    ) => {
      if (sql.includes('DELETE FROM sync_tombstones')) throw new Error('disk went away');
      return original(sql, ...(rest as []));
    }) as typeof sqlite.prepare);

    await expect(unbindLibrary({ sqlite })).rejects.toThrow('disk went away');
    spy.mockRestore();

    expect(readSkybridgeCredentials()).toEqual(credentials);
    // The transaction rolled back whole, so the library is still bound.
    expect(counts()).toMatchObject({ changes: 1, binding: 1, cursors: 1 });
  });
});
