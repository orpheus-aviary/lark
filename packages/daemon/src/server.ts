import cors from '@fastify/cors';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { corsOriginDelegate } from './access-guard.js';
import type { AppContext } from './context.js';
import { fail } from './response.js';
import { registerSystemRoutes } from './routes/system.js';

/**
 * Build the Fastify instance without listening — `cli.ts` binds the socket,
 * tests drive it through `app.inject()`.
 */
export function buildServer(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false }); // we log through ctx.logger

  app.register(cors, {
    origin: corsOriginDelegate(),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Fastify turns a handler throw into a bare 500 with no stack anywhere.
  // Mirror it into our logger and answer with the standard envelope.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    ctx.logger.error(
      { err, method: req.method, url: req.url, status: err.statusCode ?? 500 },
      'unhandled route error',
    );
    if (reply.sent) return;
    fail(
      reply,
      err.statusCode ?? 500,
      err.message || 'Internal Server Error',
      err.code ?? 'INTERNAL_ERROR',
    );
  });

  app.setNotFoundHandler((_req, reply) => {
    fail(reply, 404, 'not found', 'NOT_FOUND');
  });

  registerSystemRoutes(app);

  return app;
}
