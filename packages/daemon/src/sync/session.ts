// The in-memory sync session, and how a restart gets one back (v0.2 T3b).
//
// A session is "everything a round needs and nothing it can rediscover":
// an authenticated client, the workspace to talk about, and the two ids the
// cursor is keyed by. It exists ONLY in memory — the disk holds credentials,
// and a session is what you build from them.
//
// Restoring one at boot is deliberately offline: no request is made, nothing
// is registered, no workspace is ensured. The daemon must come up in the same
// state whether or not the network is there, and the first round is what
// discovers a token the server no longer likes.

import { type SkybridgeCredentials, readBinding, readSkybridgeCredentials } from '@lark/core';
import type { SyncAuthReason } from '@lark/shared';
import type { AppContext } from '../context.js';
import type { SkybridgeApi, SkybridgeClient } from './client.js';

export interface SyncSession {
  client: SkybridgeClient;
  serverUrl: string;
  /** From the binding row — the cursor is keyed by it, never by the URL. */
  serverId: string;
  userId: string;
  email: string;
  deviceId: string;
  workspaceId: string;
  /** The credentials this session was built from, as last written to disk. */
  credentials: SkybridgeCredentials;
}

/**
 * Build a session from credentials that are already complete.
 *
 * Throws when they are not: this is called on a path that has just verified
 * every piece, and a "partial session" is a concept that must not exist —
 * every field here is load-bearing for a push.
 */
export function buildSession(
  api: SkybridgeApi,
  credentials: SkybridgeCredentials,
  serverId: string,
): SyncSession {
  const { auth, device, workspace } = credentials;
  if (auth === undefined || device === undefined || workspace === undefined) {
    throw new Error('cannot build a sync session from incomplete credentials');
  }
  const client = api.createClient({
    authContext: {
      serverUrl: credentials.server.url,
      token: auth.token,
      user: { id: auth.user_id, email: auth.email, displayName: null },
      ...(auth.refresh_token === undefined ? {} : { refreshToken: auth.refresh_token }),
      ...(auth.expires_at === undefined ? {} : { expiresAt: auth.expires_at }),
      serverId,
    },
    deviceId: device.id,
  });
  return {
    client,
    serverUrl: credentials.server.url,
    serverId,
    userId: auth.user_id,
    email: auth.email,
    deviceId: device.id,
    workspaceId: workspace.id,
    credentials,
  };
}

export type RestoreOutcome =
  | { installed: true }
  /** Nothing to install, and why — the status renders this as `auth_required`. */
  | { installed: false; reason: SyncAuthReason }
  /** The credentials and the binding disagree; a human has to look. */
  | { installed: false; reason: null; error: string };

/**
 * Rebuild the session from disk, and leave the runtime describing the result.
 *
 * Called at boot, after a token refresh, and by a login that failed after it
 * had already dropped the previous session — which is why it also SETS the
 * status rather than only reporting it: every caller wants the same mapping
 * from "could not install" to what `GET /sync/status` says.
 *
 * Reads the binding as well as the credentials, and refuses to install a
 * session whose workspace is not the one this library is bound to. That
 * combination should be impossible — the two are written in one transaction —
 * so meeting it means the file was hand-edited or restored from somewhere
 * else, and syncing a library into the wrong workspace is precisely the damage
 * the binding exists to prevent.
 */
export function restoreSession(ctx: AppContext): RestoreOutcome {
  const outcome = resolveRestore(ctx);
  if (!outcome.installed) {
    if (outcome.reason === null) ctx.sync.noteError(outcome.error);
    else ctx.sync.noteAuthRequired(outcome.reason);
  }
  return outcome;
}

function resolveRestore(ctx: AppContext): RestoreOutcome {
  let credentials: SkybridgeCredentials | null;
  try {
    credentials = readSkybridgeCredentials();
  } catch (err) {
    return {
      installed: false,
      reason: null,
      error: `the credential file could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (credentials === null) return { installed: false, reason: 'missing_session' };
  if (
    credentials.auth === undefined ||
    credentials.device === undefined ||
    credentials.workspace === undefined
  ) {
    return { installed: false, reason: 'credentials_missing' };
  }

  const binding = readBinding(ctx.sqlite);
  if (binding === null) {
    // Credentials without a binding: the login transaction writes both, so
    // this only happens to a library the credentials did not come from.
    return { installed: false, reason: 'credentials_missing' };
  }
  if (binding.workspace_id !== credentials.workspace.id) {
    return {
      installed: false,
      reason: null,
      error: `this library is bound to workspace ${binding.workspace_id} but the credentials name ${credentials.workspace.id} — log in again`,
    };
  }

  ctx.sync.installSession(buildSession(ctx.sync.api, credentials, binding.server_id));
  return { installed: true };
}
