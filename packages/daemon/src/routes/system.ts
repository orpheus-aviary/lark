import { API_PATHS, type StatusData } from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ok } from '../response.js';

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /status — liveness probe. Permanently unauthenticated: the GUI and CLI
  // probe it before they can read the token file, and it is the only exemption
  // in the Bearer gate. `pid` is what lets `stop-daemon` / the GUI prove the
  // process behind the pid file really is this daemon (M2-3).
  app.get(API_PATHS.status, async (_req, reply) => {
    ok(
      reply,
      {
        status: 'ok',
        pid: process.pid,
        uptime: process.uptime(),
        version: ctx.version,
      } satisfies StatusData,
      'daemon is running',
    );
  });
}
