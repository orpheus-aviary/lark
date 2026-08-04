import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SseDisconnect, SseHttpError, parseSseBlock, subscribeSse } from './sse.js';
import { configureTransport } from './transport.js';

const BASE = 'http://127.0.0.1:47100';

/** A closed SSE response carrying `chunks` verbatim. */
function sseResponse(chunks: readonly string[], status = 200): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * A response whose body stays open until `signal` aborts — what a real fetch
 * does, and what lets the subscribe loop actually unwind on teardown.
 */
function openSseResponse(signal: AbortSignal): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener('abort', () => controller.close(), { once: true });
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

beforeEach(() => {
  configureTransport({
    baseUrl: () => BASE,
    getAuthHeaders: () => ({ Authorization: 'Bearer t' }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseSseBlock', () => {
  it('parses an event name and single-line data', () => {
    expect(parseSseBlock('event: hello\ndata: {"type":"hello"}')).toEqual({
      event: 'hello',
      data: '{"type":"hello"}',
    });
  });

  it('joins multi-line data with newlines', () => {
    expect(parseSseBlock('event: x\ndata: a\ndata: b')?.data).toBe('a\nb');
  });

  it('skips comment lines (the keepalive) and blank lines', () => {
    expect(parseSseBlock(':\nevent: ping\n\ndata: 1')).toEqual({ event: 'ping', data: '1' });
  });

  it('returns null for a block with no event field', () => {
    expect(parseSseBlock('data: orphan')).toBeNull();
  });

  it('warns about an unrecognised line but still parses the block', () => {
    const warnings: string[] = [];
    const frame = parseSseBlock('event: x\nid: 7\ndata: 1', (m) => warnings.push(m));
    expect(frame).toEqual({ event: 'x', data: '1' });
    expect(warnings).toHaveLength(1);
  });
});

describe('subscribeSse', () => {
  it('delivers events from the first connection', async () => {
    const ctrl = new AbortController();
    const events: [string, string][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(sseResponse(['event: hello\ndata: {"a":1}\n\n'])),
    );

    subscribeSse({
      path: '/events',
      signal: ctrl.signal,
      onEvent: (e, d) => events.push([e, d]),
      warn: () => {},
      onDisconnect: () => 'stop',
    });

    await vi.waitFor(() => expect(events).toEqual([['hello', '{"a":1}']]));
    ctrl.abort();
  });

  it('reconnects after a clean close and resets the backoff', async () => {
    const ctrl = new AbortController();
    const events: string[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sseResponse([]))
      .mockResolvedValueOnce(sseResponse(['event: songs:changed\ndata: {}\n\n']))
      .mockImplementation(async () => openSseResponse(ctrl.signal));
    vi.stubGlobal('fetch', fetchMock);

    subscribeSse({
      path: '/events',
      signal: ctrl.signal,
      onEvent: (e) => events.push(e),
      warn: () => {},
      backoffMs: [1],
    });

    await vi.waitFor(() => expect(events).toEqual(['songs:changed']));
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    ctrl.abort();
  });

  it('reports a clean close exactly once, with the token that attempt used', async () => {
    const ctrl = new AbortController();
    const seen: SseDisconnect[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(sseResponse([])));

    subscribeSse({
      path: '/events',
      signal: ctrl.signal,
      onEvent: () => {},
      warn: () => {},
      onDisconnect: (info) => {
        seen.push(info);
        return 'stop';
      },
    });

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ error: null, clean: true, usedToken: 't' });
    ctrl.abort();
  });

  it('does not fire onDisconnect when torn down via abort', async () => {
    const ctrl = new AbortController();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => openSseResponse(ctrl.signal));
    vi.stubGlobal('fetch', fetchMock);
    const onDisconnect = vi.fn();

    subscribeSse({
      path: '/events',
      signal: ctrl.signal,
      onEvent: () => {},
      warn: () => {},
      onDisconnect,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('hands a non-2xx status AND body to onDisconnect, and `stop` ends the loop (M2-14)', async () => {
    const ctrl = new AbortController();
    const body = JSON.stringify({
      success: false,
      message: 'gui registration required',
      error_code: 'GUI_REGISTRATION_REQUIRED',
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    const seen: SseDisconnect[] = [];

    subscribeSse({
      path: '/events?role=gui&gui_id=dead',
      signal: ctrl.signal,
      onEvent: () => {},
      warn: () => {},
      backoffMs: [1],
      onDisconnect: (info) => {
        seen.push(info);
        return 'stop';
      },
    });

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const err = seen[0].error;
    expect(err).toBeInstanceOf(SseHttpError);
    expect((err as SseHttpError).status).toBe(409);
    expect(JSON.parse((err as SseHttpError).body).error_code).toBe('GUI_REGISTRATION_REQUIRED');

    // The whole point of 'stop': the dead gui_id must not be retried forever.
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    ctrl.abort();
  });

  it('sends the same headers snapshot it reports as usedToken', async () => {
    const ctrl = new AbortController();
    let issued = 0;
    configureTransport({
      baseUrl: () => BASE,
      // Rotates on every read: a second snapshot would desync header/usedToken.
      getAuthHeaders: () => ({ Authorization: `Bearer tok-${++issued}` }),
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const seen: SseDisconnect[] = [];

    subscribeSse({
      path: '/events',
      signal: ctrl.signal,
      onEvent: () => {},
      warn: () => {},
      onDisconnect: (info) => {
        seen.push(info);
        return 'stop';
      },
    });

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const init = fetchMock.mock.calls[0][1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${seen[0].usedToken}`);
    expect(headers.Accept).toBe('text/event-stream');
    ctrl.abort();
  });
});
