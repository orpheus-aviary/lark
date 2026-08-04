import {
  InvalidIdError,
  InvalidReorderError,
  InvalidSourceError,
  NotFoundError,
  SourceKeyConflictError,
} from '@lark/core';
import type { ApiResponse, StatusData } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_LOCAL_TOKEN,
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from './testing/build-test-server.js';

let app: TestApp;
let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
  app = buildTestServer(ctx);
  // Fixtures for the error-mapping cases. Registered after buildServer, which
  // is fine: the auth / host hooks were added before any route.
  app.get('/boom/not-found', async () => {
    throw new NotFoundError('song', 'a3e1f2c4-0000-4000-8000-000000000000');
  });
  app.get('/boom/invalid-id', async () => {
    throw new InvalidIdError('../etc/passwd');
  });
  app.get('/boom/invalid-source', async () => {
    throw new InvalidSourceError('source_provider and source_key must be set together');
  });
  app.get('/boom/key-conflict', async () => {
    throw new SourceKeyConflictError('11111111-2222-4333-8444-555555555555', 'bilibili', 'BV1:2');
  });
  app.get('/boom/invalid-reorder', async () => {
    throw new InvalidReorderError('anchors are not adjacent');
  });
  app.get('/boom/unknown', async () => {
    throw new Error('something went sideways');
  });
  app.post('/echo', async (req, reply) => reply.send({ success: true, data: req.body }));
});

afterEach(async () => {
  await app.close();
  closeTestContext(ctx);
});

describe('GET /status', () => {
  it('answers with the standard envelope and needs no token', async () => {
    const res = await app.injectRaw({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);

    const body = res.json<ApiResponse<StatusData>>();
    expect(body.success).toBe(true);
    expect(body.message).toBe('daemon is running');
    expect(body.data?.status).toBe('ok');
    expect(body.data?.pid).toBe(process.pid);
    expect(body.data?.version).toBe('0.1.0');
    expect(typeof body.data?.uptime).toBe('number');
  });

  it('stays public with a query string attached', async () => {
    const res = await app.injectRaw({ method: 'GET', url: '/status?probe=1' });
    expect(res.statusCode).toBe(200);
  });
});

describe('bearer gate', () => {
  it('401s a route with no Authorization header', async () => {
    const res = await app.injectRaw({ method: 'GET', url: '/events' });
    expect(res.statusCode).toBe(401);
    expect(res.json<ApiResponse>()).toMatchObject({ success: false, error_code: 'UNAUTHORIZED' });
  });

  it('401s a wrong token, and logs nothing (the 401 path must stay cheap)', async () => {
    const res = await app.injectRaw({
      method: 'GET',
      url: '/events',
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(ctx.logger.records).toHaveLength(0);
  });

  it('401s a token of the right length but wrong content', async () => {
    const wrong = `${TEST_LOCAL_TOKEN.slice(0, -1)}X`;
    const res = await app.injectRaw({
      method: 'GET',
      url: '/boom/unknown',
      headers: { authorization: `Bearer ${wrong}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s a non-bearer Authorization scheme', async () => {
    const res = await app.injectRaw({
      method: 'GET',
      url: '/boom/unknown',
      headers: { authorization: `Token ${TEST_LOCAL_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s an unregistered path BEFORE deciding it is a 404', async () => {
    const res = await app.injectRaw({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(401);
  });

  it('404s an unregistered path once authenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json<ApiResponse>()).toMatchObject({ success: false, error_code: 'NOT_FOUND' });
  });

  it('refuses to build a server with no token (fail-closed)', () => {
    const naked = createTestContext();
    naked.localToken = '';
    expect(() => buildTestServer(naked)).toThrow(/localToken/);
    closeTestContext(naked);
  });
});

describe('Host header check', () => {
  it.each([['localhost:47100'], ['127.0.0.1:47100'], ['[::1]:47100'], ['localhost']])(
    'allows the loopback host %s',
    async (host) => {
      const res = await app.inject({ method: 'GET', url: '/status', headers: { host } });
      expect(res.statusCode).toBe(200);
    },
  );

  it('403s a rebinding host that resolves to loopback', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/status',
      headers: { host: 'evil.example:47100' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<ApiResponse>()).toMatchObject({ error_code: 'HOST_NOT_ALLOWED' });
  });
});

describe('error handler — class ① core business errors', () => {
  it.each([
    ['/boom/not-found', 404, 'NOT_FOUND'],
    ['/boom/invalid-id', 400, 'INVALID_ID'],
    ['/boom/invalid-source', 400, 'INVALID_SOURCE'],
    ['/boom/key-conflict', 409, 'SOURCE_KEY_CONFLICT'],
    ['/boom/invalid-reorder', 400, 'INVALID_REORDER'],
  ])('maps %s to %i %s without an error log', async (url, status, code) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(status);
    expect(res.json<ApiResponse>()).toMatchObject({ success: false, error_code: code });
    expect(ctx.logger.errors()).toHaveLength(0);
  });

  it('carries the conflicting song id in details', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom/key-conflict' });
    expect(res.json<ApiResponse>().details).toEqual({
      conflicting_song_id: '11111111-2222-4333-8444-555555555555',
    });
  });
});

describe('error handler — class ② Fastify 4xx', () => {
  it('keeps the 400 of a malformed JSON body and does not log an error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().success).toBe(false);
    expect(ctx.logger.errors()).toHaveLength(0);
  });

  it('keeps the 415 of an unsupported content type', async () => {
    // NB: `text/plain` would NOT be a 415 — Fastify ships a default parser for
    // it. Only a type with no registered parser reaches the 415 path.
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/xml' },
      payload: '<hello/>',
    });
    expect(res.statusCode).toBe(415);
    expect(ctx.logger.errors()).toHaveLength(0);
  });

  it('keeps the 413 of an over-sized body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 64) }),
    });
    expect(res.statusCode).toBe(413);
    expect(ctx.logger.errors()).toHaveLength(0);
  });
});

describe('error handler — class ③ everything else', () => {
  it('answers 500 INTERNAL_ERROR and logs the error with its stack', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom/unknown' });
    expect(res.statusCode).toBe(500);
    expect(res.json<ApiResponse>()).toMatchObject({ error_code: 'INTERNAL_ERROR' });

    const errors = ctx.logger.errors();
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toBe('unhandled route error');
    expect((errors[0].fields.err as Error).stack).toBeDefined();
  });
});

describe('CORS', () => {
  it('allows a loopback browser origin and echoes it back', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/status',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('allows a request with no Origin at all (CLI / curl)', async () => {
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);
  });

  it("allows Origin: null — the packaged GUI's loadFile renderer", async () => {
    const res = await app.inject({ method: 'GET', url: '/status', headers: { origin: 'null' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('null');
  });

  it('withholds the ACAO header from a foreign origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/status',
      headers: { origin: 'https://evil.example' },
    });
    // @fastify/cors does not 403 — the route still runs and the browser is what
    // refuses to hand the body to the page. So the assertion is header absence.
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
