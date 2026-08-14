// One thing, and it is the thing that was wrong: audio must not be fetched on
// the session the renderer uses.
//
// Chromium allows six sockets per origin, and lark speaks to exactly one — SSE,
// every API call, and every ranged audio request. A media element buffering a
// long file holds the whole budget, and the renderer then cannot reach the
// daemon at all: accept-gui saw it as "the GUI never re-registers after a
// daemon restart", with audio playing perfectly the entire time.
//
// The first fix was `net.fetch(url, { session })`, which type-checks (the init
// is a RequestInit) and does nothing at all — `net.fetch` has no session
// option, and the sockets stayed in the same pool. Hence this test: it asserts
// the request goes through a partitioned session's own `fetch`.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const netFetch = vi.fn();
const sessionFetch = vi.fn(async () => new Response('audio', { status: 200 }));
// Explicit parameter type: `vi.fn(() => …)` is a zero-arg signature under
// tsc, and calling it with the partition name would not compile (M5 lesson).
const fromPartition = vi.fn((_partition: string) => ({ fetch: sessionFetch }));
let installedHandler: ((request: Request) => Promise<Response>) | null = null;

vi.mock('electron', () => ({
  net: { fetch: netFetch },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn((_scheme: string, handler: (request: Request) => Promise<Response>) => {
      installedHandler = handler;
    }),
  },
  session: { fromPartition },
}));

const { installMediaProtocol } = await import('./media-protocol.js');

let dir: string;
let tokenPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-media-protocol-'));
  tokenPath = join(dir, 'daemon-token');
  writeFileSync(tokenPath, 'token-value\n');
  installedHandler = null;
  netFetch.mockClear();
  sessionFetch.mockClear();
  fromPartition.mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('installMediaProtocol', () => {
  it('fetches upstream on its own session, never on the default one', async () => {
    installMediaProtocol({ daemonOrigin: 'http://127.0.0.1:47100', tokenPath });
    expect(fromPartition).toHaveBeenCalledTimes(1);
    expect(installedHandler).not.toBeNull();

    const request = new Request('lark-media://song/9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001', {
      headers: { Range: 'bytes=0-1023' },
    });
    const response = await (installedHandler as (r: Request) => Promise<Response>)(request);

    expect(response.status).toBe(200);
    expect(netFetch).not.toHaveBeenCalled();
    expect(sessionFetch).toHaveBeenCalledTimes(1);

    const [url, init] = sessionFetch.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; bypassCustomProtocolHandlers?: boolean },
    ];
    expect(url).toBe('http://127.0.0.1:47100/audio/9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001');
    // The token is re-read per request (R29) and the range is passed through.
    expect(init.headers.Authorization).toBe('Bearer token-value');
    expect(init.headers.Range).toBe('bytes=0-1023');
    // The upstream hop must never re-enter this handler (spike-verified).
    expect(init.bypassCustomProtocolHandlers).toBe(true);
  });
});
