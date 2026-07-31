import { API_PATHS, type StatusData } from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import { DAEMON_VERSION } from '../context.js';
import { ok } from '../response.js';

export function registerSystemRoutes(app: FastifyInstance): void {
  // GET /status — liveness probe. Permanently unauthenticated: the GUI and CLI
  // probe it before they can read the token file, and M2's Bearer gate keeps an
  // explicit exemption for it.
  app.get(API_PATHS.status, async (_req, reply) => {
    ok(
      reply,
      {
        status: 'ok',
        pid: process.pid,
        uptime: process.uptime(),
        version: DAEMON_VERSION,
      } satisfies StatusData,
      'daemon is running',
    );
  });
}
