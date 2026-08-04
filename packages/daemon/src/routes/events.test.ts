// `/events` cannot be exercised through `app.inject()`: the route hijacks the
// reply and writes to the raw socket, which inject does not model. So these
// run against a real listening server on an ephemeral port.

import { type ApiResponse, type LarkEvent, parseSseBlock } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuiChannel } from '../events/gui-channel.js';
import {
  TEST_LOCAL_TOKEN,
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';

interface SseSession {
  readonly status: number;
  readonly events: LarkEvent[];
  /** Parsed failure envelope for a rejected (non-2xx) subscription. */
  readonly rejection: ApiResponse | null;
  close(): void;
}

async function openSse(url: string, token = TEST_LOCAL_TOKEN): Promise<SseSession> {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal: controller.signal,
  });

  const events: LarkEvent[] = [];
  if (!res.ok) {
    const rejection = (await res.json()) as ApiResponse;
    return { status: res.status, events, rejection, close: () => controller.abort() };
  }

  const body = res.body;
  if (body) {
    void (async () => {
      const reader = body.getReader();
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
            if (frame) events.push(JSON.parse(frame.data) as LarkEvent);
            sep = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // aborted / server closed — the collected events are what matters
      }
    })();
  }
  return { status: res.status, events, rejection: null, close: () => controller.abort() };
}

const waitForEvent = (session: SseSession, type: LarkEvent['type']): Promise<void> =>
  vi.waitFor(() => expect(session.events.some((e) => e.type === type)).toBe(true));

let ctx: TestContext;
let app: TestApp;
let base: string;
const sessions: SseSession[] = [];

async function subscribe(path: string, token?: string): Promise<SseSession> {
  const session = await openSse(`${base}${path}`, token);
  sessions.push(session);
  return session;
}

beforeEach(async () => {
  ctx = createTestContext();
  app = buildTestServer(ctx);
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await app.close();
  closeTestContext(ctx);
});

describe('GET /events', () => {
  it('sends hello on connect and forwards broadcasts', async () => {
    const session = await subscribe('/events');
    await waitForEvent(session, 'hello');

    ctx.eventsBus.emit({ type: 'songs:changed' });
    await waitForEvent(session, 'songs:changed');
  });

  it('requires the bearer token', async () => {
    const res = await fetch(`${base}/events`, { headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it.each([
    ['/events?role=admin', 'INVALID_QUERY'],
    ['/events?gui_id=x', 'INVALID_QUERY'],
    ['/events?role=gui', 'INVALID_QUERY'],
    ['/events?role=gui&gui_id=x&extra=1', 'INVALID_QUERY'],
  ])('rejects %s', async (path, code) => {
    const session = await subscribe(path);
    expect(session.status).toBe(400);
    expect(session.rejection?.error_code).toBe(code);
  });

  it('409s an unknown gui_id instead of silently degrading to a plain subscriber', async () => {
    const session = await subscribe('/events?role=gui&gui_id=11111111-1111-4111-8111-111111111111');
    expect(session.status).toBe(409);
    expect(session.rejection?.error_code).toBe('GUI_REGISTRATION_REQUIRED');
  });

  it('drops the subscription when the client goes away', async () => {
    const session = await subscribe('/events');
    await waitForEvent(session, 'hello');
    expect(ctx.eventsBus.size()).toBe(1);

    session.close();
    await vi.waitFor(() => expect(ctx.eventsBus.size()).toBe(0));
  });

  it('closes promptly with a stream still open (preClose budget)', async () => {
    const session = await subscribe('/events');
    await waitForEvent(session, 'hello');

    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('gui channel over SSE', () => {
  it('unicasts commands to the newest GUI while both keep receiving broadcasts', async () => {
    const firstId = ctx.guiChannel.register(101, '0.1.0');
    const first = await subscribe(`/events?role=gui&gui_id=${firstId}`);
    await waitForEvent(first, 'hello');

    const secondId = ctx.guiChannel.register(102, '0.1.0');
    const second = await subscribe(`/events?role=gui&gui_id=${secondId}`);
    await waitForEvent(second, 'hello');

    expect(
      ctx.guiChannel.sendToActive({ type: 'player:command', request_id: 'r1', command: 'pause' }),
    ).toBe(true);
    await waitForEvent(second, 'player:command');

    ctx.eventsBus.emit({ type: 'songs:changed' });
    await waitForEvent(first, 'songs:changed');
    expect(first.events.some((e) => e.type === 'player:command')).toBe(false);
  });

  it('promotes the older GUI when the active one disconnects', async () => {
    const firstId = ctx.guiChannel.register(101, '0.1.0');
    const first = await subscribe(`/events?role=gui&gui_id=${firstId}`);
    await waitForEvent(first, 'hello');
    const secondId = ctx.guiChannel.register(102, '0.1.0');
    const second = await subscribe(`/events?role=gui&gui_id=${secondId}`);
    await waitForEvent(second, 'hello');

    second.close();
    await vi.waitFor(() => expect(ctx.guiChannel.activeId()).toBe(firstId));

    ctx.guiChannel.sendToActive({ type: 'player:command', request_id: 'r2', command: 'next' });
    await waitForEvent(first, 'player:command');
  });

  it('recovers after a daemon restart: 409 → re-register → active again', async () => {
    const staleId = ctx.guiChannel.register(101, '0.1.0');
    // A restart replaces the whole registry — the old id is meaningless.
    ctx.guiChannel.close();
    ctx.guiChannel = new GuiChannel();

    const rejected = await subscribe(`/events?role=gui&gui_id=${staleId}`);
    expect(rejected.status).toBe(409);
    expect(rejected.rejection?.error_code).toBe('GUI_REGISTRATION_REQUIRED');

    const freshId = ctx.guiChannel.register(101, '0.1.0');
    const restored = await subscribe(`/events?role=gui&gui_id=${freshId}`);
    await waitForEvent(restored, 'hello');
    expect(ctx.guiChannel.activeId()).toBe(freshId);
  });

  it('409s a gui_id whose registration expired while disconnected', async () => {
    const shortLived = createTestContext({ guiChannel: { registrationTtlMs: 30 } });
    const shortApp = buildTestServer(shortLived);
    const shortBase = await shortApp.listen({ host: '127.0.0.1', port: 0 });
    try {
      const guiId = shortLived.guiChannel.register(101, '0.1.0');
      const session = await openSse(`${shortBase}/events?role=gui&gui_id=${guiId}`);
      await waitForEvent(session, 'hello');
      session.close();

      await vi.waitFor(() => expect(shortLived.guiChannel.isRegistered(guiId)).toBe(false));
      const rejected = await openSse(`${shortBase}/events?role=gui&gui_id=${guiId}`);
      expect(rejected.status).toBe(409);
    } finally {
      await shortApp.close();
      closeTestContext(shortLived);
    }
  });
});
