import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiResponse, CapabilitiesData, InstanceData } from '@lark/shared';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAllRoutes } from '../server.js';
import {
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';
import { LOCAL_API_VERSION } from '../version.js';

let ctx: TestContext;
let app: TestApp;

beforeEach(() => {
  ctx = createTestContext();
  app = buildTestServer(ctx);
});

afterEach(async () => {
  await app.close();
  await closeTestContext(ctx);
});

async function capabilities(): Promise<CapabilitiesData> {
  const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
  expect(res.statusCode).toBe(200);
  return res.json<ApiResponse<CapabilitiesData>>().data as CapabilitiesData;
}

/**
 * What `registerAllRoutes` actually registers, as `METHOD /path` strings.
 *
 * A bare Fastify with an `onRoute` hook is the only honest source: it sees the
 * routes as Fastify does. HEAD is dropped because Fastify derives it from GET,
 * and no CORS plugin is registered here, so there are no OPTIONS routes to
 * filter either.
 */
async function registeredRoutes(): Promise<Set<string>> {
  const bare = Fastify({ logger: false });
  const routes = new Set<string>();
  bare.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method === 'HEAD') continue;
      routes.add(`${method} ${route.url}`);
    }
  });
  registerAllRoutes(bare, ctx);
  await bare.ready();
  await bare.close();
  return routes;
}

describe('GET /api/instance', () => {
  let nest: string;

  beforeEach(() => {
    nest = mkdtempSync(join(tmpdir(), 'lark-instance-'));
    mkdirSync(join(nest, 'lark'), { recursive: true });
    vi.stubEnv('LARK_NEST_DIR', nest);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(nest, { recursive: true, force: true });
  });

  it('requires the bearer token', async () => {
    const res = await app.injectRaw({ method: 'GET', url: '/api/instance' });
    expect(res.statusCode).toBe(401);
  });

  it('ties the port to the data directory', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instance' });
    expect(res.statusCode).toBe(200);
    const data = res.json<ApiResponse<InstanceData>>().data as InstanceData;
    // realpath'd on both sides — /tmp is a symlink on macOS.
    expect(data.nest_dir).toBe(realpathSync(join(nest, 'lark')));
    expect(data.pid).toBe(process.pid);
    expect(data.version).toBe(ctx.version);
    expect(data.local_api_version).toBe(LOCAL_API_VERSION);
  });
});

describe('GET /api/capabilities', () => {
  it('describes the daemon', async () => {
    const data = await capabilities();
    expect(data.name).toBe('lark');
    expect(data.version).toBe(ctx.version);
    expect(data.endpoints.length).toBeGreaterThan(0);
  });

  it('lists exactly the routes the server registers, in both directions', async () => {
    const declared = new Set((await capabilities()).endpoints.map((e) => `${e.method} ${e.path}`));
    const registered = await registeredRoutes();

    // An endpoint with no entry is invisible to an agent…
    expect([...registered].filter((r) => !declared.has(r)).sort()).toEqual([]);
    // …and an entry with no endpoint is a promise the daemon cannot keep.
    expect([...declared].filter((d) => !registered.has(d)).sort()).toEqual([]);
  });

  it('gives every endpoint a description', async () => {
    const missing = (await capabilities()).endpoints.filter((e) => !e.description?.trim());
    expect(missing).toEqual([]);
  });
});
