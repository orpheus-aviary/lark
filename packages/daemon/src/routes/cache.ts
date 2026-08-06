// `GET /cache/status` and `POST /cache/evict` (M5-4).
//
// The status is a read of the current library — static eligibility only, never
// a network check, so it is cheap and always available. The evict route is the
// one caller that AWAITS a drain: it is an HTTP request with a user waiting on
// the answer, unlike the boot and download-finished triggers, which fire and
// observe (M5-6).

import { API_PATHS } from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import { evictResult, readCacheStatus } from '../cache.js';
import type { AppContext } from '../context.js';
import { ok } from '../response.js';

export function registerCacheRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(API_PATHS.cacheStatus, async (_req, reply) => {
    ok(reply, readCacheStatus(ctx));
  });

  app.post(API_PATHS.cacheEvict, async (_req, reply) => {
    const summary = await ctx.cacheScheduler.schedule();
    // The status fields are recomputed AFTER the drain, so the response is a
    // consistent "here is what happened and where that leaves you".
    ok(reply, evictResult(ctx, summary), 'cache eviction finished');
  });
}
