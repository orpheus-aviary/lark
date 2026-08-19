// The daemon's half of sync: assembly, and nothing else (N1f).
//
// The coordinator — the session, the lifecycle mutex, login, logout, refresh,
// the round and the status — moved into `@lark/core/portable` so a phone can
// run the same sequences. What is left here is the answer to "which host is
// this": the daemon's database pair, its event bus, its credential file, its
// hostname, its config.
//
// The wrappers below keep the daemon's own call sites — the routes, boot,
// the triggers — talking in terms of `AppContext`, so the wire layer did not
// have to change shape to accommodate a refactor underneath it.

import { hostname } from 'node:os';
import {
  type CoordinatorContext,
  type RestoreOutcome,
  type SyncLoginResult,
  type SyncLogoutResult,
  type SyncSession,
  buildSyncStatus as coordBuildStatus,
  performSyncLogin as coordLogin,
  performSyncLogout as coordLogout,
  refreshSessionToken as coordRefresh,
  requireSession as coordRequireSession,
  restoreSession as coordRestore,
  tokenNeedsRefresh as coordTokenNeedsRefresh,
  countQuarantined,
  nodeCredentialStore,
} from '@lark/core';
import { SYNC_PULL_LIMIT, type SyncLoginRequest, type SyncStatusData } from '@lark/shared';
import type { AppContext } from '../context.js';

/** The SDK error translation, re-exported so the routes have one import. */
export { callSkybridge } from '@lark/core';

/**
 * Build the coordinator's view of this daemon.
 *
 * Derived per call rather than stored on the context: every field is either a
 * handle that never changes or a closure that reads the live one, so a fresh
 * object is always current — which matters for `config`, since `PATCH /config`
 * replaces it wholesale and a captured `interval_min` would go stale.
 *
 * Reading `ctx.sync` here is what makes this throw `RuntimeNotReadyError`
 * before activation, which is the correct answer: during the audio migration
 * there is no sync runtime, and a caller that got this far found a hole in the
 * request gate.
 */
export function coordinatorContext(ctx: AppContext): CoordinatorContext {
  return {
    sync: ctx.sync,
    db: ctx.portable,
    files: ctx.files,
    logger: ctx.logger,
    credentials: nodeCredentialStore(),
    events: ctx.eventsBus,
    now: Date.now,
    deviceName: hostname,
    api: ctx.skybridge,
    fileOps: ctx.fileOps,
    countQuarantined,
    intervalMin: () => ctx.config.sync.interval_min,
    pullLimit: SYNC_PULL_LIMIT,
    version: ctx.version,
  };
}

export function performSyncLogin(
  ctx: AppContext,
  input: SyncLoginRequest,
): Promise<SyncLoginResult> {
  return coordLogin(coordinatorContext(ctx), input);
}

export function performSyncLogout(ctx: AppContext): Promise<SyncLogoutResult> {
  return coordLogout(coordinatorContext(ctx));
}

export function refreshSessionToken(ctx: AppContext): Promise<boolean> {
  return coordRefresh(coordinatorContext(ctx));
}

export function tokenNeedsRefresh(ctx: AppContext, nowMs: number): boolean {
  return coordTokenNeedsRefresh(coordinatorContext(ctx), nowMs);
}

export function restoreSession(ctx: AppContext): RestoreOutcome {
  return coordRestore(coordinatorContext(ctx));
}

export function requireSession(ctx: AppContext): SyncSession {
  return coordRequireSession(coordinatorContext(ctx));
}

export function buildSyncStatus(ctx: AppContext): SyncStatusData {
  return coordBuildStatus(coordinatorContext(ctx));
}
