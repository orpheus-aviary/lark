// Keeping the access token alive (v0.2 T3c, §4.4).
//
// The server hands out a short-lived access token and a rotating refresh
// token. A daemon that runs for days would otherwise discover the expiry as a
// 401 in the middle of a round, drop its session, and wait for a human to type
// a password — for a credential it was holding the replacement for all along.
//
// Two rules make this safe to run from a timer:
//
//   the whole exchange is inside the lifecycle mutex, so it cannot interleave
//     with a login, a logout or an unbind;
//   the epoch is captured before the request and re-checked after it. A token
//     that arrives for a session somebody replaced meanwhile is not ours to
//     write to disk — that file now belongs to a different login.
//
// A refresh that fails is not automatically fatal: only an explicit server
// verdict (`REFRESH_INVALID` / `REFRESH_REPLAYED` / 401) drops the session.
// Anything else keeps the credentials and tries again on the next tick.

import { isRefreshTokenDead } from './client.js';
import type { CoordinatorContext } from './context.js';
import { emitStatus } from './runner.js';
import { buildSession } from './session.js';

/** Refresh once the token is inside this window of its expiry. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function tokenNeedsRefresh(ctx: CoordinatorContext, nowMs: number = ctx.now()): boolean {
  const auth = ctx.sync.session?.credentials.auth;
  if (auth === undefined) return false;
  // A server that issues no expiry gives us nothing to act on; the round's own
  // 401 handling is the fallback.
  if (auth.expires_at === undefined || auth.refresh_token === undefined) return false;
  return auth.expires_at - nowMs <= REFRESH_MARGIN_MS;
}

/** Exchange the refresh token. Returns whether the session now holds a new one. */
export function refreshSessionToken(ctx: CoordinatorContext): Promise<boolean> {
  return ctx.sync.lifecycle(() => exchange(ctx));
}

async function exchange(ctx: CoordinatorContext): Promise<boolean> {
  const session = ctx.sync.session;
  const auth = session?.credentials.auth;
  if (session === null || auth === undefined || auth.refresh_token === undefined) return false;

  const epoch = ctx.sync.epoch;
  let refreshed: { token: string; refreshToken: string; expiresAt: number };
  try {
    refreshed = await ctx.api.refresh(session.serverUrl, auth.refresh_token);
  } catch (err) {
    if (isRefreshTokenDead(err)) {
      ctx.sync.dropSession('token_rejected');
      ctx.sync.lastError = 'the sync session expired — log in again';
      emitStatus(ctx);
      ctx.logger.warn({ err }, 'sync refresh token is dead — session dropped');
      return false;
    }
    ctx.logger.warn({ err }, 'sync token refresh failed, will try again');
    return false;
  }

  // Re-read from disk rather than trusting the snapshot this started with.
  //
  // The one thing that CAN move while a refresh is in flight is a round
  // discovering a 401 and calling `dropSession` — everything else (login,
  // logout, unbind) is behind the same mutex. And a dropped-for-auth session
  // is precisely what the token we are holding fixes, so the epoch alone must
  // not be the test: discarding here would send the user to a password prompt
  // while a working refresh token sat in the file.
  //
  // What DOES disqualify it is the file describing something else — no auth
  // section, another device, another workspace. Then the token belongs to a
  // session that no longer exists in any sense.
  const current = ctx.credentials.read();
  if (
    current === null ||
    current.auth === undefined ||
    current.device?.id !== session.deviceId ||
    current.workspace?.id !== session.workspaceId
  ) {
    ctx.logger.info(
      { stale_epoch: ctx.sync.isStale(epoch) },
      'sync token refreshed for a session that is gone — discarded',
    );
    return false;
  }

  const credentials = {
    ...current,
    auth: {
      ...current.auth,
      token: refreshed.token,
      refresh_token: refreshed.refreshToken,
      expires_at: refreshed.expiresAt,
    },
  };
  ctx.credentials.write(credentials);
  ctx.sync.installSession(buildSession(ctx.api, credentials, session.serverId));
  ctx.logger.info({ expires_at: refreshed.expiresAt }, 'sync token refreshed');
  return true;
}
