// What answers while the library is being converted (0.3.0 T3, §3.2-2).
//
// The order of the three preHandlers is the contract under test: Host check →
// Bearer gate → migration gate. An unauthenticated caller must still get a 401
// from a migrating daemon — if the migration gate spoke first, `/songs` would
// tell a stranger what state this library is in.

import type { ApiResponse, StatusData } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeNotReadyError, createAppContext } from '../context.js';
import {
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';

let ctx: TestContext;
let app: TestApp;

beforeEach(() => {
  ctx = createTestContext({ lifecyclePhase: 'pending' });
  app = buildTestServer(ctx);
});

afterEach(async () => {
  await app.close();
  await closeTestContext(ctx);
});

/** Routes that stand for the business surface, one per method shape. */
const BUSINESS: readonly { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string }[] = [
  { method: 'GET', url: '/songs' },
  { method: 'GET', url: '/playlists' },
  { method: 'GET', url: '/config' },
  { method: 'GET', url: '/cache/status' },
  { method: 'GET', url: '/sync/status' },
  { method: 'GET', url: '/download/tasks' },
  { method: 'POST', url: '/playlists' },
  { method: 'POST', url: '/cache/evict' },
];

describe('while the audio migration is pending', () => {
  it.each(BUSINESS)('$method $url answers 503 AUDIO_MIGRATION_PENDING', async (route) => {
    const res = await app.inject(route);

    expect(res.statusCode).toBe(503);
    const body = res.json<ApiResponse<never>>();
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('AUDIO_MIGRATION_PENDING');
  });

  it('keeps the whitelist open', async () => {
    for (const url of [
      '/status',
      '/api/instance',
      '/api/capabilities',
      '/api/audio-migration',
      // The way out of a stuck migration: a sync op that gave up owns a song
      // directory, and this is the only door to it (§3.2-10).
      '/sync/file-ops',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('lets a stuck file op be retried and discarded', async () => {
    // Both answer; `discard` refuses THIS id because no such op exists, which
    // is a 404 from the journal and not the gate's 503.
    const retry = await app.inject({ method: 'POST', url: '/sync/file-ops/retry', payload: {} });
    expect(retry.statusCode).toBe(200);

    const discard = await app.inject({
      method: 'POST',
      url: '/sync/file-ops/discard',
      payload: { id: 999 },
    });
    expect(discard.statusCode).toBe(404);
    expect(discard.json<ApiResponse<never>>().error_code).toBe('FILE_OP_NOT_FOUND');
  });

  it('refuses the backup clear — the pass is still writing there', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/audio-migration/backup/clear',
      payload: { confirm: true },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json<ApiResponse<never>>().error_code).toBe('AUDIO_MIGRATION_PENDING');
  });

  it('still authenticates first', async () => {
    const res = await app.injectRaw({ method: 'GET', url: '/songs' });

    // 401, not 503: a caller with no token learns nothing about this library.
    expect(res.statusCode).toBe(401);
    expect(res.json<ApiResponse<never>>().error_code).toBe('UNAUTHORIZED');
  });

  it('reports the phase on the unauthenticated probe', async () => {
    const res = await app.injectRaw({ method: 'GET', url: '/status' });
    const status = res.json<ApiResponse<StatusData>>().data as StatusData;

    expect(status.audio_migration).toEqual({
      phase: 'pending',
      // No runner is attached to a harness context, so the pass is `idle`: the
      // gate and the pass are separate facts, and this is the one boot state
      // where they disagree.
      state: 'idle',
      total: 0,
      done: 0,
      lost: 0,
      kept_unconverted: 0,
      asset_missing: 0,
      blocked: 0,
      blocked_file_op: 0,
    });
  });

  it('the query string does not open a route', async () => {
    const res = await app.inject({ method: 'GET', url: '/songs?limit=1' });
    expect(res.statusCode).toBe(503);
  });

  it('a path that only looks whitelisted is refused', async () => {
    const res = await app.inject({ method: 'GET', url: '/statusish' });
    expect(res.statusCode).toBe(503);
  });
});

describe('while activation runs', () => {
  it('business routes still refuse', async () => {
    ctx.lifecycle.beginActivation();
    expect(ctx.lifecycle.phase).toBe('activating');

    const res = await app.inject({ method: 'GET', url: '/songs' });
    expect(res.statusCode).toBe(503);
  });
});

describe('once the runtime is in place', () => {
  it('the same routes answer', async () => {
    ctx.lifecycle.beginActivation();
    ctx.lifecycle.finishActivation();

    const res = await app.inject({ method: 'GET', url: '/songs' });
    expect(res.statusCode).toBe(200);
  });
});

describe('the late-bound runtime', () => {
  it('says so rather than reading undefined', () => {
    const bare = createAppContext({ ...ctx });

    expect(() => bare.downloads).toThrow(RuntimeNotReadyError);
    expect(() => bare.sync).toThrow(/not active yet/);
  });
});
