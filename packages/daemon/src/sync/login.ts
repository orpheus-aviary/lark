// The login install sequence (v0.2 T3b, §3.7).
//
// The ORDER is frozen, and each step is there because the one before it can
// still fail cheaply:
//
//   normalize the URL (§3.7 HTTPS gate)      no credentials sent yet
//   remote login                             nothing to compensate if it fails
//   binding pre-check                        refuse before we register anything
//   register or REUSE a device               reuse first: a login that mints a
//                                            new device every time leaves a
//                                            trail of dead ones on the server
//   ensure the workspace + schema gate       refuse a workspace we cannot speak
//   ONE transaction: binding, backfill,      all-or-nothing: a library is
//     rebase, device stamp                   never bound-but-unpublished
//   write the credential file                after the database agrees
//   install the session
//
// And the compensation is frozen too (R5-P1-2): any failure after the remote
// login → best-effort revoke of a device WE registered this round, THEN a
// best-effort remote logout. Never the other way round — logout invalidates
// the token family, and the revoke would have no credential left to run with.
// The credential file is moved aside before it is rewritten, so a failure in
// the last two steps restores the file that was there.

import { hostname } from 'node:os';
import {
  type BackfillResult,
  type DeviceStampResult,
  type LyricsSnapshot,
  type RebaseResult,
  type SkybridgeCredentials,
  type SkybridgeStash,
  SyncBindingMismatchError,
  SyncSchemaVersionMismatchError,
  SyncUnavailableError,
  backfillOwed,
  markBackfillDone,
  normalizeSyncServerUrl,
  preReadLyrics,
  readBinding,
  readLocalDeviceUuid,
  readSkybridgeCredentials,
  readSkybridgeDeviceId,
  rebaseLocalKeys,
  runFullBackfillInTx,
  setServerTimeOffset,
  setSkybridgeDeviceId,
  stampDeviceIdInTx,
  stashSkybridgeCredentials,
  writeBindingInTx,
  writeSkybridgeCredentials,
} from '@lark/core';
import {
  SYNC_SCHEMA_VERSION,
  SYNC_WORKSPACE_NAME,
  SYNC_WORKSPACE_TOOL,
  type SyncLoginRequest,
} from '@lark/shared';
import type { ApiDevice } from '@orpheus-aviary/skybridge-proto';
import type { AppContext } from '../context.js';
import {
  type AuthContext,
  SKYBRIDGE_CLIENT_VERSION,
  type SkybridgeApi,
  type SkybridgeClient,
  callSkybridge,
} from './client.js';
import { buildSession, restoreSession } from './session.js';

export interface SyncLoginResult {
  server_url: string;
  server_id: string;
  user_id: string;
  email: string;
  device_id: string;
  device_name: string;
  /** False when this login registered a NEW device (and would revoke it on failure). */
  device_reused: boolean;
  workspace_id: string;
  backfill: BackfillResult | null;
  rebase: RebaseResult | null;
  device_stamp: DeviceStampResult | null;
}

/** Serialized against logout, refresh persistence and unbind (§3.11). */
export function performSyncLogin(
  ctx: AppContext,
  input: SyncLoginRequest,
): Promise<SyncLoginResult> {
  return ctx.sync.lifecycle(() => install(ctx, input));
}

async function install(ctx: AppContext, input: SyncLoginRequest): Promise<SyncLoginResult> {
  const api = ctx.sync.api;
  const allowInsecureHttp = input.allow_insecure_http === true;
  const serverUrl = normalizeSyncServerUrl(input.server_url, { allowInsecureHttp });

  // Nothing to compensate before this succeeds: no device, no token, no state.
  const auth = await callSkybridge('sync login', () =>
    api.login(serverUrl, input.email, input.password),
  );
  const serverId = auth.serverId;
  if (serverId === undefined || serverId === '') {
    throw new SyncUnavailableError(
      'the server did not report a server_id — it is older than skybridge 0.1.4 and cannot be bound safely',
    );
  }

  let registeredDeviceId: string | null = null;
  let stash: SkybridgeStash | null = null;
  let sessionDropped = false;

  try {
    const binding = readBinding(ctx.sqlite);
    if (binding !== null) {
      // The workspace id is not known yet; the transaction below checks it
      // against the same row before writing anything.
      assertIdentity('server_id', binding.server_id, serverId);
      assertIdentity('user_id', binding.user_id, auth.user.id);
    }

    const device = await resolveDevice(ctx, api, auth);
    if (!device.reused) registeredDeviceId = device.device.id;

    const client = api.createClient({ authContext: auth, deviceId: device.device.id });
    const workspace = await callSkybridge('workspace lookup', () =>
      client.ensureWorkspace(SYNC_WORKSPACE_TOOL, SYNC_WORKSPACE_NAME),
    );
    if (workspace.schemaVersion !== SYNC_SCHEMA_VERSION) {
      throw new SyncSchemaVersionMismatchError(SYNC_SCHEMA_VERSION, workspace.schemaVersion);
    }

    // ── What this install owes the workspace ────────────────────────────────
    //
    // Two independent questions, and the plan's §3.7 answers them separately:
    //
    //   the backfill/rebase pair runs when this transaction WRITES the binding
    //     (a first bind, or a re-bind after unbind) or when the generations
    //     say a backfill is still owed. An ordinary re-login skips both;
    //   the device stamp runs whenever the registered id differs from what the
    //     rows carry. That is the only reading under which §3.7's "device
    //     changed" branch is reachable at all — a replaced device arrives on a
    //     re-login, when the binding is long since written.
    const bindingWritten = binding === null;
    const owed = backfillOwed(ctx.sqlite);
    const republish = bindingWritten || owed;
    // Read off disk BEFORE the transaction (a transaction cannot await) and
    // re-validated inside it against the outbox (R5-2).
    const lyrics: LyricsSnapshot = owed ? await preReadLyrics(ctx.sqlite) : new Map();
    const serverNowMs = republish
      ? await callSkybridge('server time', () => api.serverTime(serverUrl))
      : Date.now();

    // The old session goes BEFORE the transaction, not after it. The backfill
    // and the rebase rewrite the keys of changes that have not been pushed;
    // a round in flight would publish the old key and leave the row holding
    // the new one — a divergence nothing later reconciles.
    await ctx.sync.teardownSession();
    sessionDropped = true;

    const installed = ctx.sqlite
      .transaction(() => {
        // Asserts against the existing row, so a workspace change is caught
        // here even though the pre-check above could not see it yet.
        writeBindingInTx(ctx.sqlite, {
          server_id: serverId,
          user_id: auth.user.id,
          workspace_id: workspace.id,
          schema_version: workspace.schemaVersion,
        });

        if (republish) setServerTimeOffset(ctx.sqlite, serverNowMs - Date.now());
        const backfill = owed ? runFullBackfillInTx(ctx.sqlite, lyrics) : null;
        // After the backfill, never before (⑬): the backfill is what
        // guarantees every surviving entity has a pending op to rewrite, which
        // is what keeps the row and the op in agreement.
        const rebase = republish ? rebaseLocalKeys(ctx.sqlite, serverNowMs) : null;

        const previous = readSkybridgeDeviceId(ctx.sqlite);
        const stamp =
          previous === device.device.id
            ? null
            : stampDeviceIdInTx(ctx.sqlite, {
                deviceId: device.device.id,
                previousId: previous,
                localUuid: readLocalDeviceUuid(ctx.sqlite),
              });
        setSkybridgeDeviceId(ctx.sqlite, device.device.id);
        if (republish) markBackfillDone(ctx.sqlite);
        return { backfill, rebase, stamp };
      })
      .immediate();

    const credentials = composeCredentials({
      serverUrl,
      allowInsecureHttp,
      auth,
      device: device.device,
      workspaceId: workspace.id,
    });

    stash = stashSkybridgeCredentials();
    writeSkybridgeCredentials(credentials);
    ctx.sync.installSession(buildSession(api, credentials, serverId));
    stash.discard();
    stash = null;

    ctx.logger.info(
      {
        server_url: serverUrl,
        workspace_id: workspace.id,
        device_id: device.device.id,
        device_reused: device.reused,
        backfill: installed.backfill,
        rebase_entities: installed.rebase?.entities ?? 0,
        device_stamp: installed.stamp?.mode ?? 'unchanged',
      },
      'sync login installed',
    );

    return {
      server_url: serverUrl,
      server_id: serverId,
      user_id: auth.user.id,
      email: auth.user.email,
      device_id: device.device.id,
      device_name: device.device.name,
      device_reused: device.reused,
      workspace_id: workspace.id,
      backfill: installed.backfill,
      rebase: installed.rebase,
      device_stamp: installed.stamp,
    };
  } catch (err) {
    stash?.restore();
    if (sessionDropped) {
      // The credential file is back to whatever it was, so this rebuilds the
      // session that was running before the attempt — or reports why it
      // cannot, which is what a fresh install gets.
      restoreSession(ctx);
    }
    await compensate(ctx, api, auth, registeredDeviceId);
    throw err;
  }
}

function assertIdentity(field: string, bound: string, incoming: string): void {
  if (bound !== incoming) throw new SyncBindingMismatchError(field, bound, incoming);
}

interface ResolvedDevice {
  device: ApiDevice;
  /** True when the server still knows the id this install already had. */
  reused: boolean;
}

/**
 * Reuse the existing registration when the server still honours it.
 *
 * A login that registers unconditionally leaves one dead device per login on
 * the account, and — worse — changes the third element of every LWW key this
 * device issues from then on, for no reason the user asked for.
 */
async function resolveDevice(
  ctx: AppContext,
  api: SkybridgeApi,
  auth: AuthContext,
): Promise<ResolvedDevice> {
  // Only `registerDevice` and `listDevices` are callable without a device id.
  const bootstrap = api.createClient({ authContext: auth });
  const stored = storedDeviceId(ctx);

  if (stored !== null) {
    const devices = await callSkybridge('device list', () => bootstrap.listDevices());
    const hit = devices.find((device) => device.id === stored);
    if (hit !== undefined && hit.revokedAt === null) return { device: hit, reused: true };
    ctx.logger.info(
      { device_id: stored, known: hit !== undefined },
      'stored sync device is gone or revoked — registering a new one',
    );
  }

  const device = await callSkybridge('device registration', () =>
    bootstrap.registerDevice({
      name: hostname(),
      appVersion: `lark ${ctx.version}`,
      clientVersion: SKYBRIDGE_CLIENT_VERSION,
    }),
  );
  return { device, reused: false };
}

/**
 * The id this install already has, from either place that remembers it.
 *
 * The database is the authority (it is what the rows are stamped with); the
 * credential file is the fallback for the window where a login wrote the file
 * but the row is from an older shape.
 */
function storedDeviceId(ctx: AppContext): string | null {
  const fromDb = readSkybridgeDeviceId(ctx.sqlite);
  if (fromDb !== null) return fromDb;
  try {
    return readSkybridgeCredentials()?.device?.id ?? null;
  } catch {
    return null; // an unreadable file is not a device id
  }
}

function composeCredentials(input: {
  serverUrl: string;
  allowInsecureHttp: boolean;
  auth: AuthContext;
  device: ApiDevice;
  workspaceId: string;
}): SkybridgeCredentials {
  return {
    server: {
      url: input.serverUrl,
      ...(input.allowInsecureHttp ? { allow_insecure_http: true } : {}),
    },
    auth: {
      user_id: input.auth.user.id,
      email: input.auth.user.email,
      token: input.auth.token,
      ...(input.auth.refreshToken === undefined ? {} : { refresh_token: input.auth.refreshToken }),
      ...(input.auth.expiresAt === undefined ? {} : { expires_at: input.auth.expiresAt }),
    },
    device: { id: input.device.id, name: input.device.name },
    workspace: { id: input.workspaceId },
  };
}

/**
 * Undo what this attempt left on the server. Best effort by definition — the
 * login already failed, and a second failure here must not replace the error
 * the user needs to see.
 */
async function compensate(
  ctx: AppContext,
  api: SkybridgeApi,
  auth: AuthContext,
  registeredDeviceId: string | null,
): Promise<void> {
  const client: SkybridgeClient = api.createClient({
    authContext: auth,
    ...(registeredDeviceId === null ? {} : { deviceId: registeredDeviceId }),
  });

  // A device we registered THIS round is ours to take back. One that was
  // already there is not — revoking it would log the user's other machine out
  // because their new machine failed to log in.
  if (registeredDeviceId !== null) {
    try {
      await client.revokeDevice(registeredDeviceId);
    } catch (err) {
      ctx.logger.warn(
        { err, device_id: registeredDeviceId },
        'could not revoke the device this failed login registered',
      );
    }
  }

  try {
    await client.logout();
  } catch (err) {
    ctx.logger.warn({ err }, 'could not release the token this failed login obtained');
  }
}
