// The `/workspaces` surface (N7e-2), and criterion 115 at the wire.
//
// What is on trial is that a switch says what it did and did nothing else: the
// daemon goes on serving the library it has open, and the caller is told to
// restart rather than shown a screen that quietly still has the old one.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeWorkspaceId, createDatabase, createSong, paths } from '@lark/core';
import {
  API_PATHS,
  type ApiResponse,
  type WorkspaceSwitchData,
  type WorkspacesData,
} from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';

const ACCOUNT = computeWorkspaceId('server-1', 'user-1');

let nest: string;
let ctx: TestContext;
let app: TestApp;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-route-workspaces-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  mkdirSync(join(nest, 'lark'), { recursive: true });
  paths.invalidateActiveWorkspace();
  // File-backed: `GET /workspaces` counts what is in each library by opening
  // it, and an in-memory one is not on the disk it looks at.
  ctx = createTestContext({ dbPath: paths.dbPath() });
  app = buildTestServer(ctx);
});

afterEach(async () => {
  await closeTestContext(ctx);
  vi.unstubAllEnvs();
  paths.invalidateActiveWorkspace();
  rmSync(nest, { recursive: true, force: true });
});

const bodyOf = <T>(raw: string): ApiResponse<T> => JSON.parse(raw) as ApiResponse<T>;

const list = async (): Promise<WorkspacesData> => {
  const res = await app.inject({ method: 'GET', url: API_PATHS.workspaces });
  expect(res.statusCode).toBe(200);
  return bodyOf<WorkspacesData>(res.body).data as WorkspacesData;
};

const switchTo = async (id: string): Promise<{ statusCode: number; body: string }> => {
  const res = await app.inject({
    method: 'POST',
    url: API_PATHS.workspacesSwitch,
    payload: { workspace_id: id },
  });
  return { statusCode: res.statusCode, body: res.body };
};

/** A second library on disk, which is what a switch insists on. */
function materialise(id: string): void {
  mkdirSync(paths.workspacePaths(id).root, { recursive: true });
  createDatabase({ dbPath: paths.workspacePaths(id).db }).sqlite.close();
}

describe('GET /workspaces', () => {
  it('answers with local alone on a device that has never logged in', async () => {
    createSong(ctx.portable, { name: '第一首', artist: '某人' });
    const data = await list();

    expect(data.serving).toBe('local');
    expect(data.serving_has_sync_traces).toBe(false);
    expect(data.workspaces).toEqual([
      { id: 'local', label: '', server_url: '', active: true, songs: 1, playlists: 0 },
    ]);
  });

  it('lists a second library once there is one', async () => {
    materialise(ACCOUNT);
    const data = await list();
    expect(data.workspaces.map((w) => w.id)).toEqual(['local', ACCOUNT]);
    expect(data.workspaces.find((w) => w.id === ACCOUNT)?.active).toBe(false);
  });
});

describe('POST /workspaces/switch', () => {
  it('writes the switch and asks for a restart', async () => {
    materialise(ACCOUNT);
    const res = await switchTo(ACCOUNT);

    expect(res.statusCode).toBe(200);
    expect(bodyOf<WorkspaceSwitchData>(res.body).data).toEqual({
      id: ACCOUNT,
      previous: 'local',
      changed: true,
      restart_required: true,
    });
  });

  it('keeps serving the library it already has open', async () => {
    createSong(ctx.portable, { name: '第一首', artist: '某人' });
    materialise(ACCOUNT);
    await switchTo(ACCOUNT);

    // Criterion 115's other half: not half-switched. The daemon answers about
    // the library it is serving, and says which one that is.
    const data = await list();
    expect(data.serving).toBe('local');
    expect(data.workspaces.find((w) => w.id === ACCOUNT)?.active).toBe(true);
    expect(ctx.portable.sqlite.prepare('SELECT count(*) AS n FROM songs').get()).toEqual({ n: 1 });
  });

  it('says so when there was nothing to do', async () => {
    const res = await switchTo('local');
    expect(bodyOf<WorkspaceSwitchData>(res.body).data).toMatchObject({
      changed: false,
      restart_required: false,
    });
  });

  it('refuses a workspace with no library — the switch would fall back', async () => {
    const res = await switchTo(ACCOUNT);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses something that is not a workspace id', async () => {
    expect((await switchTo('../elsewhere')).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses a body with a field it does not know', async () => {
    const res = await app.inject({
      method: 'POST',
      url: API_PATHS.workspacesSwitch,
      payload: { workspace_id: 'local', restart: true },
    });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res.body).error_code).toBe('INVALID_BODY');
  });
});
