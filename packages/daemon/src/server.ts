import cors from '@fastify/cors';
import { isDaemonEnvelopeErrorCode } from '@lark/shared';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { corsOriginDelegate, isHostAllowed } from './access-guard.js';
import { checkLocalToken } from './auth.js';
import type { AppContext } from './context.js';
import { mapCoreError } from './error-mapping.js';
import { isMigrationWhitelisted } from './migration/whitelist.js';
import { fail } from './response.js';
import { registerAudioMigrationRoutes } from './routes/audio-migration.js';
import { registerCacheRoutes } from './routes/cache.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerConflictRoutes } from './routes/conflicts.js';
import { registerDebugRoutes } from './routes/debug.js';
import { registerDownloadRoutes } from './routes/download.js';
import { registerEventsRoutes } from './routes/events.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerPlayerRoutes } from './routes/player.js';
import { registerPlaylistRoutes } from './routes/playlists.js';
import { registerSongRoutes } from './routes/songs.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerSystemRoutes } from './routes/system.js';
import { InvalidRequestError } from './validation.js';

/**
 * Every route the daemon serves, in ONE place. `GET /api/capabilities` hand-
 * writes the same list for agent discovery, and the coverage guard (M2-13)
 * registers this function against a bare Fastify to diff the two sets — which
 * only works if there is a single registration entry point.
 */
export function registerAllRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerSystemRoutes(app, ctx);
  registerAudioMigrationRoutes(app, ctx);
  registerEventsRoutes(app, ctx);
  registerSongRoutes(app, ctx);
  registerPlaylistRoutes(app, ctx);
  registerMediaRoutes(app, ctx);
  registerPlayerRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerDownloadRoutes(app, ctx);
  registerCacheRoutes(app, ctx);
  registerSyncRoutes(app, ctx);
  registerConflictRoutes(app, ctx);
  // Acceptance mode only, and never listed in capabilities (M4 T6).
  if (ctx.acceptance?.debugRoutes === true) registerDebugRoutes(app, ctx);
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

  // The audio-migration gate (0.3.0 T3, §3.2-2). Third, after authentication:
  // an unauthenticated caller must not be able to tell a migrating daemon from
  // any other, and the answer below names what the library is doing.
  //
  // It reads the in-memory phase, never the database flag. The flag is cleared
  // in the middle of activation, and a per-request read of it would open the
  // business routes in the window before their runtime exists.
  app.addHook('preHandler', async (req, reply) => {
    if (ctx.lifecycle.phase === 'normal') return;
    if (isMigrationWhitelisted(req.method, req.url)) return;
    fail(
      reply,
      503,
      '曲库正在做一次性音频迁移（mp3 → m4a），完成后即可使用',
      'AUDIO_MIGRATION_PENDING',
    );
    return reply;
  });

  // Three-way error mapping (M2-8):
  //   ① core business errors     → their 4xx envelope, no error log
  //   ② Fastify's own 4xx        → keep the status it chose, no error log
  //      (malformed JSON 400, body over limit 413, bad Content-Type 415 …)
  //   ③ anything else            → 500 + an error log with the stack
  //
  // M3 added coded errors that map to 5xx (a failed transcode, a failed
  // commit). Those are still "mapped", but a 5xx is by definition not an
  // expected outcome of a well-formed request, so it keeps its error log.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const mapped = mapCoreError(err);
    if (mapped) {
      if (mapped.status >= 500) {
        ctx.logger.error(
          { err, method: req.method, url: req.url, status: mapped.status },
          'route failed',
        );
      }
      if (reply.sent) return;
      fail(reply, mapped.status, err.message, mapped.code, mapped.details);
      return;
    }

    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      if (reply.sent) return;
      const details = err instanceof InvalidRequestError ? err.details : undefined;
      // `err.code` is whatever threw: our own registered code, or one of
      // Fastify's `FST_ERR_*` internals. Only the former may go on the wire —
      // a client that branches on `error_code` has no mapping for a framework
      // constant, and the shared registry is the closed set it does map (M6-6).
      const code = isDaemonEnvelopeErrorCode(err.code) ? err.code : 'BAD_REQUEST';
      fail(reply, status, err.message || 'Bad Request', code, details);
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
