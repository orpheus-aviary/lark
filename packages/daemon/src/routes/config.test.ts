import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig } from '@lark/core';
import type { ApiResponse, LarkConfig, PublicLarkConfig } from '@lark/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';

let ctx: TestContext;
let app: TestApp;
let nest: string;
let configPath: string;

function boot(options: { saveConfigImpl?: (c: LarkConfig, p?: string) => void } = {}): void {
  ctx = createTestContext({
    configPath,
    saveConfigImpl: options.saveConfigImpl,
    config: loadConfig(configPath),
  });
  app = buildTestServer(ctx);
}

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-config-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  mkdirSync(join(nest, 'lark'), { recursive: true });
  configPath = join(nest, 'lark', 'lark_config.toml');
  boot();
});

afterEach(async () => {
  await app.close();
  await closeTestContext(ctx);
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const getConfig = async (): Promise<PublicLarkConfig> => {
  const res = await app.inject({ method: 'GET', url: '/config' });
  return res.json<ApiResponse<PublicLarkConfig>>().data as PublicLarkConfig;
};

const patch = (payload: object): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'PATCH', url: '/config', payload });

describe('GET /config', () => {
  it('never puts the api_key on the wire, only its presence', async () => {
    ctx.config.llm.api_key = 'sk-secret';
    const data = await getConfig();
    expect(data.llm.has_api_key).toBe(true);
    expect(JSON.stringify(data)).not.toContain('sk-secret');
  });
});

describe('PATCH /config', () => {
  it('persists to disk and swaps memory only after the save succeeds', async () => {
    const res = await patch({ window: { width: 1200 }, log: { level: 'debug' } });
    expect(res.statusCode).toBe(200);

    expect(ctx.config.window.width).toBe(1200);
    expect(loadConfig(configPath).log.level).toBe('debug'); // really on disk
    expect((await getConfig()).window.width).toBe(1200);
  });

  it('keeps unknown keys that were already on disk', async () => {
    writeFileSync(configPath, '[download]\nconcurrency = 3\n\n[window]\nwidth = 900\n', {
      mode: 0o600,
    });
    boot();

    expect((await patch({ window: { width: 1000 } })).statusCode).toBe(200);
    expect(readFileSync(configPath, 'utf-8')).toContain('concurrency');
  });

  it('clears the api_key with an empty string', async () => {
    ctx.config.llm.api_key = 'sk-secret';
    expect((await patch({ llm: { api_key: '' } })).statusCode).toBe(200);
    expect((await getConfig()).llm.has_api_key).toBe(false);
    expect(loadConfig(configPath).llm.api_key).toBe('');
  });

  it('writes the theme mode (M5-2)', async () => {
    expect((await patch({ theme: { mode: 'dark' } })).statusCode).toBe(200);
    expect((await getConfig()).theme.mode).toBe('dark');
    expect(loadConfig(configPath).theme.mode).toBe('dark');
  });

  it('writes the sync interval, and nothing else about sync (v0.2)', async () => {
    expect((await patch({ sync: { interval_min: 15 } })).statusCode).toBe(200);
    expect((await getConfig()).sync.interval_min).toBe(15);
    expect(loadConfig(configPath).sync.interval_min).toBe(15);

    // Credentials are not config: they live in skybridge.toml and only
    // `/sync/login` writes them (D1/D2).
    const res = await patch({ sync: { server_url: 'https://elsewhere.example' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().details).toEqual({ path: 'sync.server_url' });
  });

  it.each([
    ['an unknown section', { daemon: { port: 1 } }],
    ['an unknown field', { window: { depth: 3 } }],
    ['a non-object section', { window: 900 }],
    ['an empty patch', {}],
    ['a non-object body', ['window']],
  ])('rejects %s with INVALID_CONFIG', async (_label, payload) => {
    const res = await patch(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe('INVALID_CONFIG');
    expect(ctx.logger.errors()).toHaveLength(0);
  });

  /**
   * The settings page marks the offending field from `details.path` — it must
   * never parse the English message (M5-20).
   */
  it.each([
    ['a bad field value', { log: { level: 'chatty' } }, 'log.level'],
    ['an unknown field', { window: { depth: 3 } }, 'window.depth'],
    ['an unknown section', { daemon: { port: 1 } }, 'daemon'],
    ['a non-object section', { window: 900 }, 'window'],
  ])('reports %s at details.path', async (_label, payload, path) => {
    const body = (await patch(payload)).json<ApiResponse>();
    expect(body.error_code).toBe('INVALID_CONFIG');
    expect(body.details).toEqual({ path });
  });

  it('omits details when the complaint is about the whole body', async () => {
    expect((await patch({})).json<ApiResponse>().details).toBeUndefined();
  });

  /**
   * Same domain, opposite policy (M2-12): the loader converges a bad disk
   * value to the default so a config file can never block startup; PATCH
   * rejects it so a caller hears about it. Both sides are asserted on the SAME
   * value, which is what keeps the two definitions from drifting apart.
   */
  it.each([
    ['log.level', { log: { level: 'chatty' } }, 'log', 'level'],
    ['log.max_size_mb', { log: { max_size_mb: 0 } }, 'log', 'max_size_mb'],
    ['log.max_backups', { log: { max_backups: 1.5 } }, 'log', 'max_backups'],
    ['window.width', { window: { width: 0 } }, 'window', 'width'],
    ['font.global_font_size', { font: { global_font_size: 0 } }, 'font', 'global_font_size'],
    ['storage.cache_limit_mb', { storage: { cache_limit_mb: -1 } }, 'storage', 'cache_limit_mb'],
    ['sync.interval_min', { sync: { interval_min: 0 } }, 'sync', 'interval_min'],
    ['theme.mode', { theme: { mode: 'sepia' } }, 'theme', 'mode'],
    ['llm.url', { llm: { url: 42 } }, 'llm', 'url'],
  ])('rejects a bad %s that the loader would silently converge', async (_l, payload, s, k) => {
    const res = await patch(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe('INVALID_CONFIG');

    const section = (payload as Record<string, Record<string, unknown>>)[s];
    writeFileSync(configPath, `[${s}]\n${k} = ${JSON.stringify(section[k])}\n`, { mode: 0o600 });
    const loaded = loadConfig(configPath) as unknown as Record<string, Record<string, unknown>>;
    const defaults = DEFAULT_CONFIG as unknown as Record<string, Record<string, unknown>>;
    expect(loaded[s][k]).toBe(defaults[s][k]);
  });

  it('leaves memory and disk untouched when the save fails before the rename', async () => {
    boot({
      saveConfigImpl: () => {
        throw new Error('disk full');
      },
    });
    const before = readFileSync(configPath, 'utf-8');

    const res = await patch({ window: { width: 1234 } });
    expect(res.statusCode).toBe(500);
    expect(res.json<ApiResponse>().error_code).toBe('SAVE_FAILED');
    expect(ctx.config.window.width).toBe(DEFAULT_CONFIG.window.width);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
    expect(ctx.fatals).toHaveLength(0);
  });

  it('adopts the NEW disk value when the failure lands after the rename', async () => {
    // saveConfig's final act is a permission assertion AFTER the atomic
    // rename, so "save failed" does not imply "disk unchanged".
    boot({
      saveConfigImpl: (config, path) => {
        writeFileSync(path as string, `[window]\nwidth = ${config.window.width}\n`, {
          mode: 0o600,
        });
        throw new Error('post-rename permission assertion failed');
      },
    });

    const res = await patch({ window: { width: 1600 } });
    expect(res.statusCode).toBe(500);
    expect(res.json<ApiResponse>().error_code).toBe('SAVE_FAILED');
    // Memory follows disk, not the request's intent — they happen to agree here.
    expect(ctx.config.window.width).toBe(1600);
    expect(ctx.fatals).toHaveLength(0);
  });

  it('answers 500 first and only then asks to die when the reload also fails', async () => {
    const unreadable = join(nest, 'lark', 'configdir');
    mkdirSync(unreadable, { recursive: true });
    ctx = createTestContext({
      configPath: unreadable, // reading a directory throws EISDIR
      config: structuredClone(DEFAULT_CONFIG),
      saveConfigImpl: () => {
        throw new Error('disk full');
      },
    });
    app = buildTestServer(ctx);

    const res = await patch({ window: { width: 1234 } });
    expect(res.statusCode).toBe(500);
    expect(res.json<ApiResponse>().error_code).toBe('SAVE_FAILED');
    // The order matters: the response is formed BEFORE the fatal is requested,
    // because teardown waits on this very request (real exit: boot.child.test).
    expect(ctx.fatals).toHaveLength(1);

    chmodSync(unreadable, 0o755); // loadConfig tightened it; restore for cleanup
  });
});
