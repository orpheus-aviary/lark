// Logging in when the account's library is not the one this phone has open
// (N7e-4).
//
// The same sequence the daemon runs (`daemon/src/sync/workspace-login.ts`),
// through the same seam in core, for the same reason: the workspace id is a
// hash of what the server just said, so nothing can know it any earlier — and
// criteria 116 and 117 say the install must not touch the library this app is
// serving.
//
//   remote login       core's, unchanged; nothing local written yet
//   ↳ resolveTarget    compute the id · prepare the workspace if the account
//                      has none here · open it and build a context over it
//   install            core's, unchanged, against that context
//   switch             one line; the app has to be reopened to honour it
//
// THE ONE CASE THAT STAYS AS IT WAS: logging back into the workspace already
// open. There is nothing to prepare and no second handle to open, so
// `resolveTarget` is simply not passed.
//
// ⚠️ A SECOND DATABASE IS OPEN FOR THE LENGTH OF THE INSTALL, which is the one
// thing this host does that its desktop twin does not have to think about:
// expo-sqlite caches handles per (name, directory) and its `OnDestroy` does not
// close them (`boot/sequence.ts`). This one is closed explicitly in a `finally`
// and never outlives the call — it is not a second SERVING library, which is
// what `bootOnce` exists to prevent.

import {
  type CoordinatorContext,
  type SyncLoginResult,
  SyncRuntime,
  computeWorkspaceId,
  performSyncLogin,
  realSkybridgeApi,
} from '@lark/core/portable';
import {
  SYNC_PULL_LIMIT_MOBILE,
  type SyncLoginRequest,
  type WorkspaceOriginChoice,
} from '@lark/shared';
import { openLibrary } from '../db/open';
import { engineLogger } from '../downloads/log';
import { createSecureCredentialStore } from '../ports/credentials';
import { deviceName } from '../ports/device';
import { createFileSystem } from '../ports/fs';
import { activeWorkspaceId, createPathsFor, workspaceDirectory } from '../ports/paths';
import { appVersion } from '../sync/context';
import { nameWorkspace, switchWorkspace } from './index-file';
import { prepareWorkspace } from './prepare';

export interface WorkspaceLoginInput extends SyncLoginRequest {
  /** Ignored when the account already has a library here. */
  workspace_origin?: WorkspaceOriginChoice;
}

export interface WorkspaceLoginOutcome {
  login: SyncLoginResult;
  workspaceId: string;
  workspaceCreated: boolean;
  /** True when this app is still holding a different library open. */
  restartRequired: boolean;
}

/** A context over one workspace, for one install, closed when it is over. */
function targetContext(id: string): { ctx: CoordinatorContext; release: () => void } {
  const opened = openLibrary({ directoryUri: workspaceDirectory(id).uri });
  const files = { fs: createFileSystem(), paths: createPathsFor(id) };
  return {
    ctx: {
      // Triggers off: this runtime lives for one install and is thrown away. A
      // background round against a library nobody is looking at would be a
      // second syncer in one process.
      sync: new SyncRuntime({ triggers: false }),
      db: opened.db,
      files,
      logger: engineLogger,
      credentials: createSecureCredentialStore(id),
      // Nothing is looking at this library, so nothing wants to hear about it.
      events: { emit: () => {} },
      now: Date.now,
      deviceName,
      api: realSkybridgeApi,
      // A tripwire rather than a runtime: a login writes the binding, the
      // backfill, the rebase and the device stamp — it queues no file effects
      // and drains none.
      fileOps: {
        drain: () => {
          throw new Error('a login into another workspace must not drain file effects');
        },
      },
      countQuarantined: () => 0,
      intervalMin: () => 15,
      pullLimit: SYNC_PULL_LIMIT_MOBILE,
      version: appVersion(),
    },
    release: () => opened.handle.closeSync(),
  };
}

/**
 * Log in, landing the account's library where it belongs.
 *
 * Reports what happened rather than acting on it: the app cannot restart
 * itself, so telling the person is the caller's job.
 */
export async function performWorkspaceLogin(
  ctx: CoordinatorContext,
  input: WorkspaceLoginInput,
): Promise<WorkspaceLoginOutcome> {
  const serving = activeWorkspaceId();
  let targetId: string | null = null;
  let created = false;

  const login = await performSyncLogin(ctx, input, {
    resolveTarget: async (identity) => {
      const id = computeWorkspaceId(identity.serverId, identity.userId);
      targetId = id;
      // The library this app already has open. Nothing to prepare, and a
      // second handle on the same file would be a second handle on the same
      // file.
      if (id === serving) return { ctx };

      const prepared = await prepareWorkspace({
        id,
        origin: input.workspace_origin ?? 'claim',
        source: ctx.db,
      });
      created = prepared.created;
      return targetContext(id);
    },
  });

  const workspaceId = targetId as unknown as string;
  const restartRequired = workspaceId !== serving;
  // The name, every time — including a login back into the workspace already
  // open, which is how one that predates this line gets a name at all. Best
  // effort: the switcher falling back to「账号曲库 085de2c3」is a cosmetic
  // loss, a login that failed because a decoration could not be written is not
  // (N7g-2).
  try {
    await nameWorkspace(createFileSystem(), workspaceId, {
      label: login.email,
      server_url: login.server_url,
    });
  } catch (err) {
    engineLogger.warn({ err: String(err) }, 'could not name the workspace');
  }
  if (restartRequired) await switchWorkspace(createFileSystem(), workspaceId);

  return { login, workspaceId, workspaceCreated: created, restartRequired };
}
