import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYNC_PUSH_BATCH_MAX } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DatabaseHandles, createDatabase } from '../../db/index.js';
import { FileEffectRuntime } from '../../sync/file-ops-runtime.js';
import { createSong } from '../library/songs.js';
import {
  type SkybridgeClientLike,
  type SyncLocalChange,
  type SyncPullResult,
  type SyncPushResult,
  type SyncServerChange,
  readCursor,
  runSync,
} from './engine.js';
import { readServerTimeOffset } from './hlc.js';

const SERVER_ID = 'server-1';
const WORKSPACE = 'workspace-1';
const SERVER_TIME = 1_800_000_000_000;

let nest: string;
let handles: DatabaseHandles;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-engine-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  handles = createDatabase({ dbPath: ':memory:' });
});

afterEach(() => {
  handles.sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const sq = () => handles.sqlite;
const store = () => handles.portable;

/** An in-memory workspace: the smallest thing that behaves like the server. */
class FakeServer implements SkybridgeClientLike {
  readonly log: SyncServerChange[] = [];
  readonly pushes: SyncLocalChange[][] = [];
  seq = 0;
  serverTime = SERVER_TIME;
  /** Acknowledge nothing, to prove the round stops instead of spinning. */
  acknowledge = true;
  private readonly known = new Set<string>();

  seed(changes: { entityType: string; entityId: string; op: string; payload: unknown }[]): void {
    for (const c of changes) {
      this.seq += 1;
      this.log.push({
        serverSeq: this.seq,
        deviceId: 'peer-1',
        clientChangeId: randomUUID(),
        entityType: c.entityType,
        entityId: c.entityId,
        op: c.op,
        payload: c.payload,
        clientLocalSeq: this.seq,
        clientCreatedAt: 1000,
        serverReceivedAt: 2000,
        attachmentRefs: null,
      });
    }
  }

  pullChanges(_workspaceId: string, sinceSeq: number, limit = 500): Promise<SyncPullResult> {
    const rest = this.log.filter((c) => c.serverSeq > sinceSeq);
    const page = rest.slice(0, limit);
    return Promise.resolve({
      changes: page,
      hasMore: rest.length > page.length,
      latestSeq: this.seq,
      serverTime: this.serverTime,
    });
  }

  pushChanges(_workspaceId: string, changes: SyncLocalChange[]): Promise<SyncPushResult> {
    this.pushes.push(changes);
    const accepted: { clientChangeId: string; serverSeq: number }[] = [];
    const duplicates: { clientChangeId: string; serverSeq: number }[] = [];
    if (this.acknowledge) {
      for (const change of changes) {
        this.seq += 1;
        const ack = { clientChangeId: change.clientChangeId, serverSeq: this.seq };
        if (this.known.has(change.clientChangeId)) duplicates.push(ack);
        else {
          this.known.add(change.clientChangeId);
          accepted.push(ack);
        }
      }
    }
    return Promise.resolve({
      accepted,
      duplicates,
      latestSeq: this.seq,
      serverTime: this.serverTime,
    });
  }
}

const run = (server: FakeServer, extra: Partial<Parameters<typeof runSync>[0]> = {}) =>
  runSync({
    sqlite: sq(),
    client: server,
    serverId: SERVER_ID,
    workspaceId: WORKSPACE,
    nowMs: () => SERVER_TIME,
    ...extra,
  });

const pendingCount = () =>
  (
    sq().prepare('SELECT count(*) AS n FROM sync_changes WHERE synced_at IS NULL').get() as {
      n: number;
    }
  ).n;

const songPayload = (overrides: Record<string, unknown> = {}) => ({
  name: '远端的歌',
  artist: '',
  source_url: null,
  source_provider: null,
  source_key: null,
  lyrics_offset: 0,
  duration: 0,
  created_at_ms: 1000,
  updated_at_ms: 5000,
  lww_counter: 0,
  ...overrides,
});

describe('a round', () => {
  it('applies what it pulled and publishes what was pending', async () => {
    const server = new FakeServer();
    const remoteId = randomUUID();
    server.seed([{ entityType: 'song', entityId: remoteId, op: 'create', payload: songPayload() }]);
    const mine = createSong(store(), { name: '我的歌' });

    const result = await run(server);

    expect(result).toMatchObject({ pulled: 1, applied: 1, pushed: 1, cancelled: false });
    expect(sq().prepare('SELECT count(*) AS n FROM songs').get()).toEqual({ n: 2 });
    expect(pendingCount()).toBe(0);
    expect(server.pushes[0][0].entityId).toBe(mine.id);
    // Both halves of the cursor moved, and both came from the server's own
    // numbering rather than from anything this device counted.
    const cursor = readCursor(sq(), SERVER_ID, WORKSPACE);
    expect(cursor.pulledSeq).toBe(1);
    expect(cursor.pushedSeq).toBeGreaterThan(0);
  });

  it('resumes from the cursor instead of replaying the workspace', async () => {
    const server = new FakeServer();
    server.seed([
      { entityType: 'song', entityId: randomUUID(), op: 'create', payload: songPayload() },
    ]);
    await run(server);

    server.seed([
      { entityType: 'song', entityId: randomUUID(), op: 'create', payload: songPayload() },
    ]);
    const second = await run(server);

    expect(second.pulled).toBe(1);
    expect(sq().prepare('SELECT count(*) AS n FROM songs').get()).toEqual({ n: 2 });
  });

  it('walks every page the server has', async () => {
    const server = new FakeServer();
    server.seed(
      Array.from({ length: 7 }, () => ({
        entityType: 'song',
        entityId: randomUUID(),
        op: 'create',
        payload: songPayload(),
      })),
    );

    const result = await run(server, { pullLimit: 2 });

    expect(result.pulled).toBe(7);
    expect(readCursor(sq(), SERVER_ID, WORKSPACE).pulledSeq).toBe(7);
  });

  it('learns the server clock every round', async () => {
    const server = new FakeServer();
    server.serverTime = SERVER_TIME + 90_000;
    await run(server);
    // The offset is what re-bases every later local stamp onto the workspace's
    // timeline (R32-2).
    expect(readServerTimeOffset(sq())).toBe(90_000);
  });

  it('treats duplicates as settled', async () => {
    const server = new FakeServer();
    createSong(store(), { name: '推两次' });
    await run(server);

    // Same changes again, as if the previous round's response was lost.
    sq().prepare('UPDATE sync_changes SET synced_at = NULL, server_seq = NULL').run();
    const second = await run(server);

    expect(second.pushed).toBeGreaterThan(0);
    // Leaving them pending would push the same change on every round forever.
    expect(pendingCount()).toBe(0);
  });

  it('stops rather than spinning when the server acknowledges nothing', async () => {
    const server = new FakeServer();
    server.acknowledge = false;
    createSong(store(), { name: '没人收' });

    const result = await run(server);

    expect(result.pushed).toBe(0);
    expect(server.pushes).toHaveLength(1);
    expect(pendingCount()).toBeGreaterThan(0);
  });
});

describe('push boxing', () => {
  it('closes a batch on the count limit', async () => {
    const server = new FakeServer();
    const insert = sq().prepare(
      `INSERT INTO sync_changes (device_id, entity_type, entity_id, op, payload, created_at,
         client_change_id)
       VALUES ('local', 'song', ?, 'update', ?, 1, ?)`,
    );
    sq().transaction(() => {
      for (let i = 0; i < SYNC_PUSH_BATCH_MAX + 5; i++) {
        insert.run(randomUUID(), JSON.stringify(songPayload()), randomUUID());
      }
    })();

    await run(server);

    expect(server.pushes).toHaveLength(2);
    expect(server.pushes[0]).toHaveLength(SYNC_PUSH_BATCH_MAX);
    expect(server.pushes[1]).toHaveLength(5);
  });

  it('closes a batch on the byte limit, well before the count one', async () => {
    const server = new FakeServer();
    const insert = sq().prepare(
      `INSERT INTO sync_changes (device_id, entity_type, entity_id, op, payload, created_at,
         client_change_id)
       VALUES ('local', 'song', ?, 'set_lyrics', ?, 1, ?)`,
    );
    // 30 × 200KB: nowhere near 1000 changes, far past 3.5MB.
    sq().transaction(() => {
      for (let i = 0; i < 30; i++) {
        insert.run(randomUUID(), JSON.stringify({ lrc: 'x'.repeat(200 * 1024) }), randomUUID());
      }
    })();

    await run(server);

    // Count and bytes are independent server limits and either can bind first.
    expect(server.pushes.length).toBeGreaterThan(1);
    for (const batch of server.pushes) {
      const bytes = batch.reduce((n, c) => n + JSON.stringify(c.payload).length, 0);
      expect(bytes).toBeLessThanOrEqual(3.5 * 1024 * 1024);
      expect(batch.length).toBeLessThan(SYNC_PUSH_BATCH_MAX);
    }
  });
});

describe('cancellation', () => {
  it('stops between batches and keeps what it already committed', async () => {
    const server = new FakeServer();
    server.seed(
      Array.from({ length: 6 }, () => ({
        entityType: 'song',
        entityId: randomUUID(),
        op: 'create',
        payload: songPayload(),
      })),
    );
    const controller = new AbortController();
    const cancelAfterFirstPage: SkybridgeClientLike = {
      pullChanges: async (workspaceId, sinceSeq, limit) => {
        const page = await server.pullChanges(workspaceId, sinceSeq, limit);
        controller.abort();
        return page;
      },
      pushChanges: (workspaceId, changes) => server.pushChanges(workspaceId, changes),
    };

    const result = await runSync({
      sqlite: sq(),
      client: cancelAfterFirstPage,
      serverId: SERVER_ID,
      workspaceId: WORKSPACE,
      signal: controller.signal,
      pullLimit: 2,
      nowMs: () => SERVER_TIME,
    });

    expect(result.cancelled).toBe(true);
    // Cooperative, never mid-batch: the two changes it did apply are committed
    // and the cursor sits exactly there, so the next round resumes cleanly.
    expect(result.applied).toBe(2);
    expect(readCursor(sq(), SERVER_ID, WORKSPACE).pulledSeq).toBe(2);
  });
});

describe('file effects', () => {
  it('drains the journal after the batch commits', async () => {
    const server = new FakeServer();
    const song = createSong(store(), { name: '有歌词的歌' });
    server.seed([
      {
        entityType: 'song',
        entityId: song.id,
        op: 'set_lyrics',
        payload: { lrc: '[00:01.00]远端词' },
      },
    ]);
    const runtime = new FileEffectRuntime({ sqlite: sq() });

    const result = await run(server, { fileOps: runtime });

    expect(result.applied).toBe(1);
    // Executed after the commit — the journal row is the record, and running
    // it inside the transaction would change files a rollback could not undo.
    expect(sq().prepare('SELECT count(*) AS n FROM sync_file_ops').get()).toEqual({ n: 0 });
  });
});
