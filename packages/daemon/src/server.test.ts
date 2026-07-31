import type { ApiResponse, StatusData } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AppContext, type Logger, createContext } from './context.js';
import { buildServer } from './server.js';

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

let app: ReturnType<typeof buildServer>;
let ctx: AppContext;

beforeEach(() => {
  ctx = createContext({ logger: silentLogger });
  app = buildServer(ctx);
});

afterEach(async () => {
  await app.close();
});

describe('GET /status', () => {
  it('answers with the standard envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);

    const body = res.json<ApiResponse<StatusData>>();
    expect(body.success).toBe(true);
    expect(body.message).toBe('daemon is running');
    expect(body.data?.status).toBe('ok');
    expect(body.data?.pid).toBe(process.pid);
    expect(body.data?.version).toBe('0.1.0');
    expect(typeof body.data?.uptime).toBe('number');
  });
});

describe('not found', () => {
  it('answers with the standard failure envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json<ApiResponse>()).toMatchObject({ success: false, error_code: 'NOT_FOUND' });
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
    const res = await app.inject({
      method: 'GET',
      url: '/status',
      headers: { origin: 'null' },
    });
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
