// The `/sync/*` surface (v0.2 T3d, §4.4).
//
// Thin by design: every route here is a shape check, one call into
// `src/sync/`, and a projection onto the wire. The sequencing, the mutual
// exclusion and the compensation all live behind `performSyncLogin` and
// friends, because the CLI, the GUI and a future scheduler must all get the
// same behaviour and a route is the wrong place to keep it.
//
// Two rules this file holds on its own:
//
//   The password appears in exactly one expression — the call that sends it.
//   It is never logged, never echoed back, never stored. Same for the tokens
//   the login returns: the response says which device and workspace were
//   adopted, and nothing that could be replayed.
//
//   Every action answers with the same status the rest of the daemon uses for
//   that class of failure. `SYNC_AUTH_REQUIRED` is a 503, not a 401: 401 is
//   already spoken for by the daemon's own bearer token, and a client that saw
//   it here would tell the user their DAEMON token was wrong.

import {
  type FileEffectRuntime,
  type RunSyncResult,
  listFileOps,
  readBinding,
  readCursor,
} from '@lark/core';
import {
  API_PATHS,
  SYNC_FILE_OP_STATES,
  type SyncDeviceData,
  type SyncDevicesData,
  type SyncFileOpRunData,
  type SyncFileOpSummary,
  type SyncFileOpsData,
  type SyncLoginResultData,
  type SyncLogoutResultData,
  type SyncRunResultData,
  type SyncStatusData,
} from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ok } from '../response.js';
import {
  buildSyncStatus,
  callSkybridge,
  performSyncLogin,
  performSyncLogout,
  requireSession,
} from '../sync/coordinator.js';
import {
  objectBody,
  queryEnum,
  queryParams,
  requiredSafeInteger,
  requiredString,
} from '../validation.js';

/** Emails and URLs are short; the cap is against a body, not a value. */
const MAX_FIELD = 512;

export function registerSyncRoutes(app: FastifyInstance, ctx: AppContext): void {
  // POST /sync/login — the whole install sequence (§3.7). The password is used
  // once, right here, and never leaves this function.
  app.post(API_PATHS.syncLogin, async (req, reply) => {
    const body = objectBody(req.body, ['server_url', 'email', 'password', 'allow_insecure_http']);
    const result = await performSyncLogin(ctx, {
      server_url: requiredString(body, 'server_url', { maxLength: MAX_FIELD }),
      email: requiredString(body, 'email', { maxLength: MAX_FIELD }),
      password: requiredString(body, 'password', { maxLength: MAX_FIELD }),
      ...(body.allow_insecure_http === undefined
        ? {}
        : { allow_insecure_http: body.allow_insecure_http === true }),
    });

    ok(
      reply,
      {
        server_url: result.server_url,
        user_id: result.user_id,
        email: result.email,
        device_id: result.device_id,
        device_name: result.device_name,
        device_reused: result.device_reused,
        workspace_id: result.workspace_id,
        backfill:
          result.backfill === null
            ? null
            : {
                songs: result.backfill.songs,
                playlists: result.backfill.playlists,
                memberships: result.backfill.memberships,
                lyrics: result.backfill.lyrics,
                lyrics_skipped: result.backfill.lyricsSkipped,
                lyrics_oversize: result.backfill.lyricsOversize,
              },
        rebased_entities: result.rebase?.entities ?? 0,
        device_stamp: result.device_stamp?.mode ?? 'unchanged',
      } satisfies SyncLoginResultData,
      'logged in to skybridge',
    );
  });

  app.post(API_PATHS.syncLogout, async (_req, reply) => {
    const result = await performSyncLogout(ctx);
    ok(
      reply,
      {
        had_session: result.had_session,
        revoked_remotely: result.revoked_remotely,
      } satisfies SyncLogoutResultData,
      'logged out of skybridge',
    );
  });

  // POST /sync/run — a round on demand, through the same coalescer the
  // background triggers use. A caller that arrives during a round waits for
  // the FOLLOW-UP, so "run" always means "a round that started after you
  // asked".
  app.post(API_PATHS.syncRun, async (_req, reply) => {
    requireSession(ctx);
    const result = await ctx.sync.run('manual');
    ok(reply, toRunData(ctx, result), 'sync finished');
  });

  app.get(API_PATHS.syncStatus, async (_req, reply) => {
    ok(reply, buildSyncStatus(ctx) satisfies SyncStatusData);
  });

  // GET /sync/devices — every device on the account, so the user can see what
  // else is syncing and retire what is not.
  app.get(API_PATHS.syncDevices, async (_req, reply) => {
    const session = requireSession(ctx);
    const devices = await callSkybridge('device list', () => session.client.listDevices());
    ok(reply, {
      devices: devices.map(
        (device): SyncDeviceData => ({
          id: device.id,
          name: device.name,
          platform: device.platform,
          app_version: device.appVersion,
          client_version: device.clientVersion,
          created_at: device.createdAt,
          last_seen_at: device.lastSeenAt,
          revoked_at: device.revokedAt,
          is_current: device.id === session.deviceId,
        }),
      ),
    } satisfies SyncDevicesData);
  });

  // POST /sync/revoke-device — including, deliberately, this one: a user whose
  // laptop was stolen may be sitting at the laptop's replacement, and refusing
  // to let them revoke the device they are on would be the wrong protection.
  // Revoking yourself ends this session on the next round, which is honest.
  app.post(API_PATHS.syncRevokeDevice, async (req, reply) => {
    const session = requireSession(ctx);
    const body = objectBody(req.body, ['device_id']);
    const deviceId = requiredString(body, 'device_id', { maxLength: MAX_FIELD });

    await callSkybridge('device revoke', () => session.client.revokeDevice(deviceId));
    ctx.logger.info(
      { device_id: deviceId, self: deviceId === session.deviceId },
      'sync device revoked',
    );
    ok(reply, { device_id: deviceId }, 'device revoked');
  });

  // ── the file-effect journal ──
  //
  // The product-level way out of a stuck file operation (R5-P1-1). The list is
  // redacted at the source: an op that carries lyrics reports their size and
  // digest, never the text.
  app.get(API_PATHS.syncFileOps, async (req, reply) => {
    const query = queryParams(req.query, ['state']);
    const state = queryEnum(query, 'state', SYNC_FILE_OP_STATES);
    const fileOps: SyncFileOpSummary[] = listFileOps(ctx.sqlite, state);
    ok(reply, { file_ops: fileOps } satisfies SyncFileOpsData);
  });

  // No body means "retry everything that gave up" — the shape M6 froze for a
  // POST whose route reads its body: `{}` and nothing at all are the same.
  app.post(API_PATHS.syncFileOpsRetry, async (req, reply) => {
    const body = objectBody(req.body ?? {}, ['id']);
    const id = body.id === undefined ? undefined : requiredSafeInteger(body, 'id', { min: 1 });
    const journal = fileOpJournal(ctx);
    const result = await journal.exclusive(() => journal.runtime.retry(id));
    journal.afterResolution();
    ok(reply, result satisfies SyncFileOpRunData, 'file operations retried');
  });

  // Per-row, always: the op being abandoned describes a file effect that will
  // now never happen, so there is no "discard everything" shape to get wrong.
  app.post(API_PATHS.syncFileOpsDiscard, async (req, reply) => {
    const body = objectBody(req.body, ['id']);
    const id = requiredSafeInteger(body, 'id', { min: 1 });
    const journal = fileOpJournal(ctx);
    await journal.exclusive(async () => journal.runtime.discard(id));
    journal.afterResolution();
    ctx.logger.warn({ op_id: id }, 'sync file op discarded by request');
    ok(reply, { id }, 'file operation discarded');
  });
}

interface JournalAccess {
  runtime: FileEffectRuntime;
  /** Serialize against the migration pass, when there is one. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Let the migration pick up whatever the op was holding. */
  afterResolution(): void;
}

/**
 * Which journal executor answers, and what has to be kept away from it.
 *
 * These three routes are the only ones that serve in BOTH phases (§3.2-10):
 * during the migration they are a user's only way to free a song directory a
 * dead sync op is sitting on, and the normal runtime that usually owns the
 * journal does not exist yet. Choosing by phase rather than by "is there a
 * migration object" matters — the pass stays attached after it finishes, and
 * its executor has no claim registry to share with the download engine.
 */
function fileOpJournal(ctx: AppContext): JournalAccess {
  const migration = ctx.lifecycle.migration;
  if (ctx.lifecycle.phase === 'normal' || migration === null) {
    return {
      runtime: ctx.fileOps,
      exclusive: (fn) => fn(),
      afterResolution: () => {},
    };
  }
  return {
    runtime: migration.fileOps,
    exclusive: (fn) => migration.exclusive(fn),
    afterResolution: () => migration.continueAfterFileOp(),
  };
}

function toRunData(ctx: AppContext, result: RunSyncResult | null): SyncRunResultData {
  const binding = readBinding(ctx.sqlite);
  const cursor =
    binding === null
      ? { pulledSeq: 0, pushedSeq: 0 }
      : readCursor(ctx.sqlite, binding.server_id, binding.workspace_id);
  return {
    pulled: result?.pulled ?? 0,
    pushed: result?.pushed ?? 0,
    applied: result?.applied ?? 0,
    skipped: result?.skipped ?? 0,
    dead_lettered: result?.deadLettered ?? 0,
    conflicts: result?.conflicts ?? 0,
    cancelled: result?.cancelled ?? false,
    pulled_seq: cursor.pulledSeq,
    pushed_seq: cursor.pushedSeq,
  };
}
