import { API_PATHS, type LarkEvent } from '@lark/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOriginAllowed } from '../access-guard.js';
import type { AppContext } from '../context.js';
import type { GuiConnection } from '../events/gui-channel.js';
import { fail } from '../response.js';

/** Comment-line heartbeat so intermediaries don't idle the socket out. */
const KEEPALIVE_MS = 15_000;

/**
 * Write-side backpressure bound. A subscriber that stops reading (suspended
 * laptop, wedged renderer) would otherwise let the kernel-side buffer grow
 * without limit and the daemon would pay for it in RSS. Past this watermark
 * the connection is dropped; the client reconnects and `hello` tells it to
 * refresh everything, so nothing is lost that a refetch can't restore.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * Begin an SSE response: write status + headers and mark Fastify hijacked.
 *
 * `reply.hijack()` skips the onSend chain, which is where `@fastify/cors`
 * injects its headers — so the echo has to be re-applied by hand here. Unlike
 * owl, which echoes any Origin unconditionally, this runs the origin through
 * the same allowlist the CORS delegate uses: an SSE stream must not be the one
 * endpoint that hands a foreign page permission to read it.
 */
export function initSse(reply: FastifyReply, req: FastifyRequest): void {
  const origin = req.headers.origin;
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
  if (typeof origin === 'string' && origin && isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }

  reply.hijack();
  reply.raw.writeHead(200, headers);
  // Flush immediately so the client knows the stream is live before the first
  // event arrives.
  reply.raw.flushHeaders?.();
}

/** Emit one event; `false` when the stream is gone or the write threw. */
export function sendSseEvent(reply: FastifyReply, event: string, data: unknown): boolean {
  if (reply.raw.writableEnded) return false;
  try {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/** Close the SSE stream. Safe to call more than once. */
export function endSse(reply: FastifyReply): void {
  if (!reply.raw.writableEnded) reply.raw.end();
}

interface EventsQuery {
  role?: unknown;
  gui_id?: unknown;
}

export function registerEventsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const liveReplies = new Set<FastifyReply>();

  app.get(API_PATHS.events, async (req, reply) => {
    const query = (req.query ?? {}) as EventsQuery & Record<string, unknown>;
    const unknownField = Object.keys(query).find((k) => k !== 'role' && k !== 'gui_id');
    if (unknownField !== undefined) {
      return fail(reply, 400, `unknown query field: ${unknownField}`, 'INVALID_QUERY');
    }
    if (query.role !== undefined && query.role !== 'gui') {
      return fail(reply, 400, "role must be 'gui' when present", 'INVALID_QUERY');
    }

    // The 409 must happen BEFORE the hijack — once headers are written there
    // is no status code left to send. A GUI that gets it re-registers and
    // opens a new subscription with the fresh id (M2-6 / M2-14).
    let guiId: string | null = null;
    if (query.role === 'gui') {
      if (typeof query.gui_id !== 'string' || query.gui_id === '') {
        return fail(reply, 400, 'gui_id is required for role=gui', 'INVALID_QUERY');
      }
      if (!ctx.guiChannel.isRegistered(query.gui_id)) {
        return fail(
          reply,
          409,
          'unknown or expired gui_id — register again',
          'GUI_REGISTRATION_REQUIRED',
        );
      }
      guiId = query.gui_id;
    } else if (query.gui_id !== undefined) {
      return fail(reply, 400, 'gui_id requires role=gui', 'INVALID_QUERY');
    }

    initSse(reply, req);
    liveReplies.add(reply);

    let done = false;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      clearInterval(keepalive);
      unsubscribe();
      liveReplies.delete(reply);
      if (guiId !== null) ctx.guiChannel.detach(guiId, connection);
      endSse(reply);
    };

    /** Write + backpressure check. Dropping is self-healing via reconnect. */
    const write = (event: LarkEvent): boolean => {
      if (done) return false;
      if (!sendSseEvent(reply, event.type, event)) {
        cleanup();
        return false;
      }
      if ((reply.raw.socket?.writableLength ?? 0) > MAX_BUFFERED_BYTES) {
        ctx.logger.warn({ gui_id: guiId }, 'sse subscriber too slow — dropping connection');
        cleanup();
        return false;
      }
      return true;
    };

    const connection: GuiConnection = { send: write, close: cleanup };

    const unsubscribe = ctx.eventsBus.subscribe((event) => {
      write(event);
    });

    const keepalive = setInterval(() => {
      if (reply.raw.writableEnded) {
        cleanup();
        return;
      }
      reply.raw.write(':\n\n');
    }, KEEPALIVE_MS);
    keepalive.unref?.();

    req.raw.socket.on('close', cleanup);

    if (guiId !== null) ctx.guiChannel.attach(guiId, connection);
    write({ type: 'hello', server_time: Date.now() });

    // Do NOT return/await: the reply is hijacked, so Fastify is not waiting on
    // this handler. The stream lives until socket close or the preClose below.
  });

  // Without this, `server.close()` hangs forever: Fastify's onClose runs only
  // after in-flight requests drain, and an SSE stream never drains on its own.
  // (`forceCloseConnections` is NOT the answer — it would also kill in-flight
  // CRUD requests on other routes.)
  app.addHook('preClose', async () => {
    for (const reply of [...liveReplies]) {
      try {
        endSse(reply);
      } catch {
        // best-effort; the socket 'close' listener still runs cleanup
      }
    }
    liveReplies.clear();
  });
}
