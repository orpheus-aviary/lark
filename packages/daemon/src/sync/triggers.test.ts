import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncLoginRequest } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TestContext,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';
import { type FakeSkybridge, createFakeSkybridge } from '../testing/fake-skybridge.js';
import { performSyncLogin } from './login.js';
import { performSyncLogout } from './logout.js';
import { type SyncHandles, attachSyncHandles } from './triggers.js';

let nest: string;
let ctx: TestContext;
let fake: FakeSkybridge;
let handles: SyncHandles;
let clock: number;

const request: SyncLoginRequest = {
  server_url: 'https://sync.example.test',
  email: 'someone@example.test',
  password: 'correct horse',
};

beforeEach(async () => {
  nest = mkdtempSync(join(tmpdir(), 'lark-sync-triggers-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  mkdirSync(join(nest, 'lark'), { recursive: true });
  clock = 1_000_000;
  fake = createFakeSkybridge();
  ctx = createTestContext({ skybridge: fake.api });
  // A second set of handles over the same context, driven by hand: the tick
  // methods are the seam, so a debounce assertion never waits a real second.
  // No timers are started (`triggersEnabled` is false in tests).
  handles = attachSyncHandles(ctx, { now: () => clock, random: () => 0.5 });
  await performSyncLogin(ctx, request);
});

afterEach(async () => {
  await closeTestContext(ctx);
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

/** An unpushed change, which is what the outbox watcher looks for. */
function addPendingChange(): void {
  ctx.sqlite
    .prepare(
      `INSERT INTO sync_changes (device_id, entity_type, entity_id, op, payload, created_at, client_change_id)
       VALUES ('local', 'song', ?, 'create', '{}', 1, ?)`,
    )
    .run(randomUUID(), randomUUID());
}

const pulls = () => fake.count('pull');

describe('the coalescer', () => {
  it('serves a caller that arrives mid-round with the FOLLOW-UP, not the round in flight', async () => {
    const first = handles.run('manual');
    const second = handles.run('manual');

    expect(second).not.toBe(first);
    await Promise.all([first, second]);
    // Two rounds, because the second caller's change may have landed after the
    // first round read the outbox.
    expect(pulls()).toBe(2);
  });

  it('folds every caller that arrives during one round into a single follow-up', async () => {
    const first = handles.run('manual');
    const rest = [handles.run('outbox'), handles.run('scheduler'), handles.run('remote')];

    await Promise.all([first, ...rest]);

    expect(pulls()).toBe(2);
    expect(new Set(rest.map((p) => p))).toHaveProperty('size', 1);
  });

  it('runs the follow-up even when the round in flight failed', async () => {
    fake.failAt('pull', new Error('offline'));
    const first = handles.run('manual').catch(() => 'failed');
    const second = handles.run('manual').catch(() => 'failed');

    await Promise.all([first, second]);
    expect(pulls()).toBe(2);
  });
});

describe('the outbox watcher', () => {
  it('does nothing while the outbox is clean', () => {
    handles.tickOutbox();
    expect(pulls()).toBe(0);
  });

  it('waits for the burst to settle before pushing', async () => {
    addPendingChange();
    handles.tickOutbox(); // first sighting: the debounce anchor
    expect(pulls()).toBe(0);

    clock += 500;
    addPendingChange(); // still typing
    handles.tickOutbox();
    expect(pulls()).toBe(0);

    clock += 900; // quiet for longer than 800ms
    handles.tickOutbox();
    await handles.abortAndDrain();
    expect(pulls()).toBe(1);
  });

  it('gives up waiting after five seconds of a growing outbox', async () => {
    for (let i = 0; i < 12; i++) {
      addPendingChange();
      handles.tickOutbox();
      clock += 500; // never quiet
    }
    await handles.abortAndDrain();
    // Starvation is what fires it: a user pasting a hundred links must not
    // wait for the typing to stop.
    expect(pulls()).toBeGreaterThanOrEqual(1);
  });

  it('backs off after a failure instead of hammering once a second', async () => {
    fake.failAt('pull', new Error('offline'));
    addPendingChange();
    handles.tickOutbox(); // the sighting sets the debounce anchor
    clock += 1000;
    handles.tickOutbox();
    await handles.abortAndDrain();
    expect(pulls()).toBe(1);

    clock += 1000; // inside the 2s backoff
    handles.tickOutbox();
    await handles.abortAndDrain();
    expect(pulls()).toBe(1);

    clock += 2000; // past it
    handles.tickOutbox();
    await handles.abortAndDrain();
    expect(pulls()).toBe(2);
  });

  it('stays silent without a session', async () => {
    addPendingChange();
    await performSyncLogout(ctx);
    clock += 5000;

    handles.tickOutbox();

    expect(pulls()).toBe(0);
  });
});

describe('the server stream', () => {
  it('subscribes on the first tick with a session, and runs when the server pushes', async () => {
    handles.tickOutbox();
    expect(fake.stream).not.toBeNull();

    fake.emitRemoteChange(7);
    await handles.abortAndDrain();

    expect(pulls()).toBe(1);
  });

  it('closes the stream when the session goes', async () => {
    handles.tickOutbox();
    const stream = fake.stream;

    await performSyncLogout(ctx);
    handles.tickOutbox();

    expect(stream?.closed).toBe(true);
  });

  it('waits before resubscribing after a stream error', () => {
    handles.tickOutbox();
    fake.stream?.handlers.onError?.(new Error('stream died'));

    handles.tickOutbox();
    expect(fake.count('createClient')).toBeGreaterThan(0); // sanity: same client
    // Still the same (dead) stream object: a server refusing the stream must
    // not be asked once a second.
    const before = fake.stream;
    clock += 5_000;
    handles.tickOutbox();
    expect(fake.stream).toBe(before);

    clock += 30_000;
    handles.tickOutbox();
    expect(fake.stream).not.toBe(before);
  });
});

describe('stop', () => {
  it('ends the stream and refuses to start anything else', async () => {
    handles.tickOutbox();
    const stream = fake.stream;

    handles.stop();
    addPendingChange();
    clock += 5000;
    handles.tickOutbox();

    expect(stream?.closed).toBe(true);
    expect(pulls()).toBe(0);
  });
});
