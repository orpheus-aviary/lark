// R5② — the pull size a host chooses is the pull size the server is asked for.
//
// R5① asserts the constant exists and R5③ measures what it costs on the
// device. Neither of those would notice the failure that actually matters:
// a `pullLimit` that is set on the coordinator context, read by nobody, and
// silently replaced by `SYNC_PULL_LIMIT` three frames down. The number would
// be right in the source, right on the panel, and wrong on the wire.
//
// So this drives a real round with a capturing client and reads the argument
// off the request. The seam is `engine.ts`'s `options.pullLimit ?? SYNC_PULL_LIMIT`.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYNC_PULL_LIMIT, SYNC_PULL_LIMIT_MOBILE } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoordinatorHarness } from '../../testing/coordinator-harness.js';
import { createFakeSkybridge } from '../../testing/fake-skybridge.js';
import type { CoordinatorContext } from './context.js';
import { performSyncLogin } from './login.js';
import { runSyncRound } from './runner.js';

const REQUEST = {
  server_url: 'https://sync.example.test',
  email: 'someone@example.test',
  password: 'correct horse',
};

let nest: string;
let ctx: ReturnType<typeof createCoordinatorHarness>;
let fake: ReturnType<typeof createFakeSkybridge>;
/** Every `pullChanges` limit this round asked for, in order. */
let limits: number[];

beforeEach(async () => {
  nest = mkdtempSync(join(tmpdir(), 'lark-pull-limit-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  fake = createFakeSkybridge();
  limits = [];
  const createClient = fake.api.createClient;
  fake.api.createClient = (options) => {
    const client = createClient(options);
    const pullChanges = client.pullChanges.bind(client);
    client.pullChanges = (workspaceId: string, since: number, limit: number) => {
      limits.push(limit);
      return pullChanges(workspaceId, since, limit);
    };
    return client;
  };
  ctx = createCoordinatorHarness({ api: fake.api });
  await performSyncLogin(ctx, REQUEST);
  limits.length = 0;
});

afterEach(() => {
  ctx.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const round = (context: CoordinatorContext): Promise<unknown> =>
  runSyncRound(context, { triggers: ['manual'], signal: new AbortController().signal });

describe('the pull limit reaches the server', () => {
  it("asks for the context's size, not the default", async () => {
    await round({ ...ctx, pullLimit: SYNC_PULL_LIMIT_MOBILE });
    expect(limits.length).toBeGreaterThan(0);
    expect(new Set(limits)).toEqual(new Set([SYNC_PULL_LIMIT_MOBILE]));
    // Fails loudly if someone "simplifies" the seam away: 200 and 500 are both
    // plausible-looking numbers, and only one of them was measured on a phone.
    expect(limits).not.toContain(SYNC_PULL_LIMIT);
  });

  it('asks for the desktop size when the desktop assembles the context', async () => {
    await round({ ...ctx, pullLimit: SYNC_PULL_LIMIT });
    expect(new Set(limits)).toEqual(new Set([SYNC_PULL_LIMIT]));
  });
});
