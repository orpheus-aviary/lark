// Logging in when the account's library is not the one this daemon is serving
// (N7e-2).
//
// Since N7 an account's library lives at `libraries/<id>/`, and `id` is
// `sha256(server_id + "\n" + user_id)` — which nothing knows until the server
// has answered. So the sequence is:
//
//   remote login            (core's, unchanged; nothing local written yet)
//   ↳ resolveTarget         ← this file
//       compute the id
//       prepare the workspace if the account has none here
//       open it, take ITS writer lock, build a context over it
//   install                 (core's, unchanged, against that context)
//   switch + restart        (the caller)
//
// 🔴 WHY THE INSTALL CANNOT RUN ON THE OPEN LIBRARY. Criterion 116 says a NEW
// workspace must leave the current library without one extra outbox row, and
// 117 says a CLAIMED one must leave it complete and unbound. Binding the
// library this process is serving and then copying or moving it fails both.
//
// THE ONE CASE THAT STAYS EXACTLY AS IT WAS: logging back into the account
// whose workspace is already open. There is no second library to prepare, the
// daemon already holds the writer lock, and opening a second handle on the
// same file would deadlock against itself. `resolveTarget` is simply not
// passed, and core takes the path it has taken since v0.2.

import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  type CoordinatorContext,
  type SyncLoginResult,
  SyncRuntime,
  type WorkspaceOrigin,
  type WriterLock,
  acquireWriterLock,
  computeWorkspaceId,
  performSyncLogin as coordLogin,
  createDatabase,
  nameWorkspace,
  nodeCredentialStore,
  nodeFileContext,
  paths,
  prepareWorkspace,
  switchWorkspace,
} from '@lark/core';
import { SYNC_PULL_LIMIT, type SyncLoginRequest } from '@lark/shared';
import type { AppContext } from '../context.js';
import { coordinatorContext } from './coordinator.js';

/** How long to wait for whoever else is writing the target. Seconds, not minutes. */
const TARGET_LOCK_WAIT_MS = 5_000;

export interface WorkspaceLoginRequest extends SyncLoginRequest {
  /**
   * What to do when this account has no library on this device yet.
   *
   * Ignored when it already has one — logging into the same account twice
   * lands on the same copy, which is what a deterministic id is for.
   */
  workspace_origin?: WorkspaceOrigin;
}

export interface WorkspaceLoginResult {
  login: SyncLoginResult;
  /** The workspace the account's library is in. */
  workspace_id: string;
  /** True when this login created it. */
  workspace_created: boolean;
  /**
   * True when the daemon is now serving a DIFFERENT library from the one this
   * account uses. The GUI turns this into "restart to open it".
   */
  restart_required: boolean;
}

/**
 * Open one workspace's library for the length of an install, and give it back.
 *
 * Its own writer lock, because it is a different file from the one the daemon
 * holds; its own `SyncRuntime`, because the session this builds belongs to a
 * library nobody is serving and must not be installed into the live one.
 */
function contextFor(ctx: AppContext, id: string): { ctx: CoordinatorContext; release: () => void } {
  const target = paths.workspacePaths(id);
  const lock: WriterLock = acquireWriterLock({
    dbPath: target.db,
    busyTimeoutMs: TARGET_LOCK_WAIT_MS,
  });
  let handles: ReturnType<typeof createDatabase>;
  try {
    // No logger: `createDatabase` wants pino's and the daemon's context holds
    // the narrowed one. What it would say about a library nobody is serving
    // belongs in this file's own log line anyway.
    handles = createDatabase({ dbPath: target.db });
  } catch (err) {
    lock.release();
    throw err;
  }

  // The TARGET's song paths, not the active workspace's: the login's backfill
  // reads lyrics off disk, and it has to read the library it is installing.
  const files = { ...nodeFileContext(), paths: paths.workspacePathsPort(id) };
  return {
    ctx: {
      // Triggers off: this runtime exists for one install and is thrown away.
      // A background round against a library nobody is serving would be a
      // second syncer in one process.
      sync: new SyncRuntime({ triggers: false }),
      db: handles.portable,
      files,
      logger: ctx.logger,
      credentials: nodeCredentialStore(target.skybridgeConfig),
      // Nothing is looking at this library, so nothing wants to hear about it.
      events: { emit: () => {} },
      now: Date.now,
      deviceName: hostname,
      api: ctx.skybridge,
      // A tripwire rather than a runtime. A login writes the binding, the
      // backfill, the rebase and the device stamp — it queues no file effects
      // and drains none. If this is ever called, the sequence changed and the
      // desktop's runtime would have quarantined into the ACTIVE workspace's
      // `recovered-songs/`, which is not this library's.
      fileOps: {
        drain: () => {
          throw new Error('a login into another workspace must not drain file effects');
        },
      },
      countQuarantined: () => 0,
      intervalMin: () => ctx.config.sync.interval_min,
      pullLimit: SYNC_PULL_LIMIT,
      version: ctx.version,
    },
    release: () => {
      handles.sqlite.close();
      lock.release();
    },
  };
}

/**
 * Log in, landing the account's library where it belongs.
 *
 * Answers what happened rather than acting on it: switching is one atomic line
 * and the caller is the one that knows whether anybody wants to be told to
 * restart.
 */
export async function performWorkspaceLogin(
  ctx: AppContext,
  input: WorkspaceLoginRequest,
): Promise<WorkspaceLoginResult> {
  const active = paths.resolveActiveWorkspace().id;
  let targetId: string | null = null;
  let created = false;

  const login = await coordLogin(coordinatorContext(ctx), input, {
    resolveTarget: async (identity) => {
      const id = computeWorkspaceId(identity.serverId, identity.userId);
      targetId = id;
      if (id === active) {
        // The library this daemon is already serving. Nothing to prepare, and
        // a second handle on it would fight the lock this process holds.
        return { ctx: coordinatorContext(ctx) };
      }

      if (!existsSync(paths.workspacePaths(id).db)) {
        const prepared = await prepareWorkspace({
          id,
          origin: input.workspace_origin ?? 'claim',
          source: ctx.sqlite,
          sourceSongs: paths.songsDir(),
          logger: ctx.logger,
        });
        created = prepared.created;
      }
      return contextFor(ctx, id);
    },
  });

  const workspaceId = targetId as unknown as string;
  const restartRequired = workspaceId !== active;
  // The name, every time — including a login back into the workspace already
  // open, which is how a workspace that predates this line gets one. Best
  // effort: a switcher that shows a hash is a cosmetic loss, a login that
  // failed because a decoration could not be written is not (N7g-2).
  try {
    nameWorkspace(workspaceId, { label: login.email, server_url: login.server_url }, ctx.logger);
  } catch (err) {
    ctx.logger.warn({ err, workspace: workspaceId }, 'could not name the workspace');
  }
  if (restartRequired) switchWorkspace(workspaceId, ctx.logger);

  return {
    login,
    workspace_id: workspaceId,
    workspace_created: created,
    restart_required: restartRequired,
  };
}
