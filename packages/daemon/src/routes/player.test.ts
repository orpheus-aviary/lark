// The ack round-trip needs a real socket (the command rides an SSE stream and
// the answer comes back over a second HTTP request), so these run against a
// listening server with a simulated GUI.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSong } from '@lark/core';
import {
  type ApiResponse,
  type LarkEvent,
  type PlayerStatusResponse,
  parseSseBlock,
} from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TEST_LOCAL_TOKEN,
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';

const UNKNOWN_UUID = '9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001';
const auth = { authorization: `Bearer ${TEST_LOCAL_TOKEN}` };
const jsonAuth = { ...auth, 'content-type': 'application/json' };

let ctx: TestContext;
let app: TestApp;
let base: string;
let nest: string;

interface GuiSim {
  readonly guiId: string;
  readonly commands: LarkEvent[];
  close(): void;
}

const guis: GuiSim[] = [];

const post = (path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify(body ?? {}),
  });

const envelope = async (res: Response): Promise<ApiResponse> => (await res.json()) as ApiResponse;

/**
 * A stand-in for the M4 renderer: register, subscribe as `role=gui`, and
 * answer commands according to `ack` ('ok' | 'fail' | 'none' — the last one
 * models a wedged GUI).
 */
async function connectGui(ack: 'ok' | 'fail' | 'none' = 'ok'): Promise<GuiSim> {
  const registered = await envelope(await post('/gui/register', { pid: 4242, version: '0.1.0' }));
  const guiId = (registered.data as { gui_instance_id: string }).gui_instance_id;

  const controller = new AbortController();
  const stream = await fetch(`${base}/events?role=gui&gui_id=${guiId}`, {
    headers: { ...auth, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const commands: LarkEvent[] = [];

  void (async () => {
    const reader = stream.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf('\n\n');
        while (sep !== -1) {
          const frame = parseSseBlock(buffer.slice(0, sep));
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf('\n\n');
          if (!frame) continue;
          const event = JSON.parse(frame.data) as LarkEvent;
          if (event.type !== 'player:command') continue;
          commands.push(event);
          if (ack === 'none') continue;
          await post('/player/ack', {
            request_id: event.request_id,
            ok: ack === 'ok',
            message: ack === 'fail' ? 'no audio device' : undefined,
          });
        }
      }
    } catch {
      // aborted — nothing to clean up beyond what the server sees
    }
  })();

  const sim: GuiSim = { guiId, commands, close: () => controller.abort() };
  guis.push(sim);
  // Wait for the daemon to see the association before commands are sent.
  await vi.waitFor(() => expect(ctx.guiChannel.activeId()).toBe(guiId));
  return sim;
}

beforeEach(async () => {
  nest = mkdtempSync(join(tmpdir(), 'lark-player-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  ctx = createTestContext({ ackTimeoutMs: 300 });
  app = buildTestServer(ctx);
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterEach(async () => {
  for (const gui of guis.splice(0)) gui.close();
  await app.close();
  await closeTestContext(ctx);
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

describe('POST /gui/register', () => {
  it('mints an id and reports capacity exhaustion as 409', async () => {
    const res = await post('/gui/register', { pid: 4242, version: '0.1.0' });
    expect(res.status).toBe(200);
    expect((await envelope(res)).data).toMatchObject({
      gui_instance_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });

    const full = createTestContext({ guiChannel: { capacity: 1 } });
    const fullApp = buildTestServer(full);
    const fullBase = await fullApp.listen({ host: '127.0.0.1', port: 0 });
    try {
      const first = await fetch(`${fullBase}/gui/register`, {
        method: 'POST',
        headers: jsonAuth,
        body: JSON.stringify({ pid: 101, version: '0.1.0' }),
      });
      const firstId = ((await envelope(first)).data as { gui_instance_id: string }).gui_instance_id;
      // Occupy the only slot with a live connection…
      full.guiChannel.attach(firstId, { send: () => true, close: () => {} });
      const second = await fetch(`${fullBase}/gui/register`, {
        method: 'POST',
        headers: jsonAuth,
        body: JSON.stringify({ pid: 102, version: '0.1.0' }),
      });
      expect(second.status).toBe(409);
      expect((await envelope(second)).error_code).toBe('GUI_CAPACITY');
    } finally {
      await fullApp.close();
      await closeTestContext(full);
    }
  });

  it.each([
    ['a missing pid', { version: '0.1.0' }],
    ['a pid of 1', { pid: 1, version: '0.1.0' }],
    ['a float pid', { pid: 1.5, version: '0.1.0' }],
    ['an unknown field', { pid: 42, version: '0.1.0', role: 'gui' }],
  ])('rejects %s', async (_label, body) => {
    const res = await post('/gui/register', body);
    expect(res.status).toBe(400);
  });
});

describe('player commands', () => {
  it('409s every command while no GUI is connected', async () => {
    const res = await post('/player/pause');
    expect(res.status).toBe(409);
    expect((await envelope(res)).error_code).toBe('GUI_OFFLINE');
  });

  it('round-trips a command through the active GUI', async () => {
    const gui = await connectGui('ok');
    const song = createSong(ctx.portable, { name: 's' });

    const res = await post('/player/play', { song_id: song.id });
    expect(res.status).toBe(200);
    expect(gui.commands).toHaveLength(1);
    expect(gui.commands[0]).toMatchObject({ command: 'play', song_id: song.id });
    expect(ctx.player.pendingCount).toBe(0);
  });

  it('forwards a GUI failure as 502', async () => {
    await connectGui('fail');
    const res = await post('/player/pause');
    expect(res.status).toBe(502);
    const body = await envelope(res);
    expect(body.error_code).toBe('GUI_ERROR');
    expect(body.message).toBe('no audio device');
  });

  it('504s a GUI that never acknowledges', async () => {
    await connectGui('none');
    const res = await post('/player/next');
    expect(res.status).toBe(504);
    expect((await envelope(res)).error_code).toBe('GUI_TIMEOUT');
    expect(ctx.player.pendingCount).toBe(0);
  });

  it('ignores a late ack instead of rejecting it', async () => {
    const gui = await connectGui('none');
    const timedOut = await post('/player/next');
    expect(timedOut.status).toBe(504);

    const late = await post('/player/ack', {
      request_id: (gui.commands[0] as { request_id: string }).request_id,
      ok: true,
    });
    expect(late.status).toBe(200);
    expect((await envelope(late)).data).toEqual({ matched: false });
  });

  it('sends to the newest GUI only, exactly once', async () => {
    const first = await connectGui('ok');
    const second = await connectGui('ok');

    const res = await post('/player/resume');
    expect(res.status).toBe(200);
    expect(second.commands).toHaveLength(1);
    expect(first.commands).toHaveLength(0);
  });

  it('fails an in-flight command immediately when the GUI disconnects', async () => {
    const gui = await connectGui('none');
    const pending = post('/player/pause');
    await vi.waitFor(() => expect(ctx.player.pendingCount).toBe(1));

    const started = Date.now();
    gui.close();
    const res = await pending;

    expect(res.status).toBe(409);
    expect((await envelope(res)).error_code).toBe('GUI_OFFLINE');
    // The point of failing on disconnect: it must NOT wait out the ack timeout.
    expect(Date.now() - started).toBeLessThan(300);
  });

  it('fails immediately when the write to the active GUI fails', async () => {
    await connectGui('ok');
    vi.spyOn(ctx.guiChannel, 'sendToActive').mockReturnValue(false);

    const res = await post('/player/pause');
    expect(res.status).toBe(409);
    expect((await envelope(res)).error_code).toBe('GUI_OFFLINE');
    expect(ctx.player.pendingCount).toBe(0);
    vi.restoreAllMocks();
  });

  it('releases in-flight commands with 503 when the daemon tears down', async () => {
    await connectGui('none');
    const pending = post('/player/pause');
    await vi.waitFor(() => expect(ctx.player.pendingCount).toBe(1));

    ctx.player.failAll({ kind: 'shutting-down' });
    const res = await pending;
    expect(res.status).toBe(503);
    expect((await envelope(res)).error_code).toBe('SHUTTING_DOWN');
  });

  it('404s play for a song that does not exist, without dispatching', async () => {
    const gui = await connectGui('ok');
    const res = await post('/player/play', { song_id: UNKNOWN_UUID });
    expect(res.status).toBe(404);
    expect(gui.commands).toHaveLength(0);
  });

  it('accepts every command shape the contract freezes', async () => {
    const gui = await connectGui('ok');
    const song = createSong(ctx.portable, { name: 's' });

    const calls: [string, unknown][] = [
      ['/player/play-playlist', { playlist_id: 'all' }],
      ['/player/play-playlist', { playlist_id: UNKNOWN_UUID, song_id: song.id }],
      ['/player/switch-playlist', { playlist_id: 'all' }],
      ['/player/pause', {}],
      ['/player/resume', {}],
      ['/player/next', {}],
      ['/player/prev', {}],
      ['/player/seek', { position: 12.5 }],
      ['/player/mode', { mode: 'repeat-one' }],
    ];
    for (const [path, body] of calls) {
      expect((await post(path, body)).status, path).toBe(200);
    }
    expect(gui.commands).toHaveLength(calls.length);
  });

  it.each([
    ['a non-uuid song_id', '/player/play', { song_id: 'abc' }],
    ['a bad playlist_id', '/player/switch-playlist', { playlist_id: 'everything' }],
    ['a negative seek', '/player/seek', { position: -1 }],
    ['a non-numeric seek', '/player/seek', { position: '10' }],
    ['a missing seek position', '/player/seek', {}],
    ['an unknown play mode', '/player/mode', { mode: 'party' }],
    ['a payload on pause', '/player/pause', { song_id: UNKNOWN_UUID }],
  ])('rejects %s', async (_label, path, body) => {
    await connectGui('ok');
    const res = await post(path, body);
    expect(res.status).toBe(400);
  });
});

describe('report and status', () => {
  const validReport = {
    current_song: { id: UNKNOWN_UUID, name: '青花瓷', artist: '周杰伦' },
    is_playing: true,
    current_time: 12.5,
    duration: 240,
    play_mode: 'sequential',
    playlist_id: 'all',
  };

  it('mirrors the last report and flips gui_online with the connection', async () => {
    const before = await envelope(await fetch(`${base}/player/status`, { headers: auth }));
    expect(before.data).toEqual({ gui_online: false, player: null, reported_at: null });

    const gui = await connectGui('ok');
    expect((await post('/player/report', validReport)).status).toBe(200);

    const after = (await envelope(await fetch(`${base}/player/status`, { headers: auth })))
      .data as PlayerStatusResponse;
    expect(after.gui_online).toBe(true);
    expect(after.player).toEqual(validReport);
    expect(typeof after.reported_at).toBe('number');

    gui.close();
    await vi.waitFor(async () => {
      const offline = (await envelope(await fetch(`${base}/player/status`, { headers: auth })))
        .data as PlayerStatusResponse;
      expect(offline.gui_online).toBe(false);
      // The mirror survives the disconnect — it is the last known truth.
      expect(offline.player).toEqual(validReport);
    });
  });

  it.each([
    ['a missing field', { ...validReport, is_playing: undefined }],
    ['an unknown field', { ...validReport, volume: 0.5 }],
    ['a bad play_mode', { ...validReport, play_mode: 'party' }],
    ['a negative current_time', { ...validReport, current_time: -1 }],
    ['a non-uuid song id', { ...validReport, current_song: { id: 'x', name: 'n', artist: '' } }],
    ['a bad playlist_id', { ...validReport, playlist_id: 'everything' }],
  ])('rejects %s without touching the mirror', async (_label, body) => {
    const res = await post('/player/report', body);
    expect(res.status).toBe(400);
    expect(ctx.player.lastReport).toBeNull();
  });

  it('accepts a report with no current song', async () => {
    const res = await post('/player/report', { ...validReport, current_song: null });
    expect(res.status).toBe(200);
    expect(ctx.player.lastReport?.current_song).toBeNull();
  });
});
