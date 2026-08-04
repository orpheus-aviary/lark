// Bearer gate for the local daemon (R21/R29).
//
// One token, one exemption: `GET /status` is the liveness probe the GUI and
// CLI hit BEFORE they can read the 0600 token file, so it stays public
// forever. Everything else — every method, every path, including paths no
// route claims — needs the token, so a future route can never join the public
// surface by accident.
//
// The 401 branch is deliberately the cheapest path in the server: no logging,
// no DB, no allocation beyond the envelope. The M0 media spike showed the
// renderer firing a burst of `lark-media://` range requests with a stale token
// after a daemon restart; each must cost ~nothing (spike §6.3-7).

import { timingSafeEqual } from 'node:crypto';
import { API_PATHS } from '@lark/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { fail } from './response.js';

/** Extract the bearer token from an `Authorization` header, or null. */
export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const prefix = 'bearer ';
  if (authorization.toLowerCase().startsWith(prefix)) {
    return authorization.slice(prefix.length).trim() || null;
  }
  return null;
}

/**
 * The single unauthenticated route. The query string is stripped first —
 * `/status?x=1` is the same route, and a suffix check would let `/statusfoo`
 * or `/status/../songs` through.
 */
export function isPublicPath(method: string, url: string): boolean {
  return method === 'GET' && url.split('?')[0] === API_PATHS.status;
}

/**
 * Constant-time string equality that never throws on a length mismatch
 * (`timingSafeEqual` requires equal-length buffers, so length is compared
 * first — an over-long / Unicode / empty candidate must be `false`, not a 500).
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Returns `true` when the request is blocked (a 401 has been sent), `false`
 * when it may proceed. Fail-closed: any missing piece answers 401. Shared by
 * the auth preHandler and the not-found handler, so an unregistered path is
 * authenticated before it is 404'd.
 */
export function checkLocalToken(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (isPublicPath(req.method, req.url)) return false;
  const token = bearerToken(req.headers.authorization);
  if (token && ctx.localToken && timingSafeEqualStr(token, ctx.localToken)) return false;
  fail(reply, 401, 'daemon token required', 'UNAUTHORIZED');
  return true;
}
