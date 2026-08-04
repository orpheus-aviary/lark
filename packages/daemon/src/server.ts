import cors from '@fastify/cors';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { corsOriginDelegate, isHostAllowed } from './access-guard.js';
import { checkLocalToken } from './auth.js';
import type { AppContext } from './context.js';
import { mapCoreError } from './error-mapping.js';
import { fail } from './response.js';
import { registerEventsRoutes } from './routes/events.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerPlaylistRoutes } from './routes/playlists.js';
import { registerSongRoutes } from './routes/songs.js';
import { registerSystemRoutes } from './routes/system.js';

/**
 * Every route the daemon serves, in ONE place. `GET /api/capabilities` hand-
 * writes the same list for agent discovery, and the coverage guard (M2-13)
 * registers this function against a bare Fastify to diff the two sets — which
 * only works if there is a single registration entry point.
 */
export function registerAllRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerSystemRoutes(app, ctx);
  registerEventsRoutes(app, ctx);
  registerSongRoutes(app, ctx);
  registerPlaylistRoutes(app, ctx);
  registerMediaRoutes(app, ctx);
}

/**
 * Build the Fastify instance without listening — `boot.ts` binds the socket,
 * tests drive it through `app.inject()` (see `testing/build-test-server.ts`).
 *
 * Hook order is the contract: Host check → Bearer gate → routes. A spoofed
 * Host is rejected before any route work, and nothing runs unauthenticated.
 */
export function buildServer(ctx: AppContext): FastifyInstance {
  // Fail-closed: gating on an absent secret would silently make every route
  // public. Refuse to build instead.
  if (!ctx.localToken) {
    throw new Error('daemon requires ctx.localToken to be set (fail-closed)');
  }

  const app = Fastify({ logger: false }); // we log through ctx.logger

  app.register(cors, {
    origin: corsOriginDelegate(),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Anti DNS-rebinding. Preflight OPTIONS is answered by @fastify/cors in
  // onRequest and never reaches a preHandler, so this cannot break CORS.
  app.addHook('preHandler', async (req, reply) => {
    if (!isHostAllowed(req.headers.host)) {
      fail(reply, 403, 'host not allowed', 'HOST_NOT_ALLOWED');
      return reply;
    }
  });

  app.addHook('preHandler', async (req, reply) =>
    checkLocalToken(ctx, req, reply) ? reply : undefined,
  );

  // Three-way error mapping (M2-8):
  //   ① core business errors     → their 4xx envelope, no error log
  //   ② Fastify's own 4xx        → keep the status it chose, no error log
  //      (malformed JSON 400, body over limit 413, bad Content-Type 415 …)
  //   ③ anything else            → 500 + an error log with the stack
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const mapped = mapCoreError(err);
    if (mapped) {
      if (reply.sent) return;
      fail(reply, mapped.status, err.message, mapped.code, mapped.details);
      return;
    }

    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      if (reply.sent) return;
      fail(reply, status, err.message || 'Bad Request', err.code ?? 'BAD_REQUEST');
      return;
    }

    ctx.logger.error({ err, method: req.method, url: req.url, status }, 'unhandled route error');
    if (reply.sent) return;
    fail(reply, 500, err.message || 'Internal Server Error', 'INTERNAL_ERROR');
  });

  // An unregistered path must not skip the gate: authenticate first (401
  // without a valid token), then answer a plain 404. Self-contained, so the
  // behaviour holds regardless of whether Fastify runs global preHandlers for
  // the not-found route.
  app.setNotFoundHandler((req, reply) => {
    if (checkLocalToken(ctx, req, reply)) return reply;
    fail(reply, 404, 'not found', 'NOT_FOUND');
    return reply;
  });

  registerAllRoutes(app, ctx);

  return app;
}
