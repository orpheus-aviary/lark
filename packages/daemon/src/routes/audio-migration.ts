// The migration's own surface (0.3.0 T3b, §3.2-4/§3.2-5, §4-m).
//
// Three routes, and each one exists because without it a user is stuck:
//
//   GET  /api/audio-migration           what happened, object by object. The
//        only detailed channel there is while the library is not served — and
//        it stays readable afterwards, because the ledger is the report.
//   POST /api/audio-migration/retry     "I freed some space / installed ffmpeg,
//        try again." Without it a `blocked_environment` daemon stays blocked
//        until someone thinks to restart it.
//   POST /api/audio-migration/backup/clear   the originals are the user's, and
//        so is the disk they sit on. An invisible permanent occupancy is not
//        something this migration is allowed to leave behind.
//
// The clear is the only destructive one, and it carries four locks: it is NOT
// whitelisted (so a migrating daemon refuses it outright — the pass may still
// be moving files into that directory), it wants an explicit confirmation in
// the body, it runs under the migration's mutex, and core deletes the DIRECTORY
// rather than the paths the ledger names, which is what makes escaping it
// impossible rather than merely checked.

import { clearMigrationBackups } from '@lark/core';
import {
  API_PATHS,
  type AudioMigrationBackupClearData,
  type AudioMigrationData,
  type AudioMigrationRetryData,
} from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { audioMigrationCounts, audioMigrationReport, redactPaths } from '../migration/report.js';
import { ok } from '../response.js';
import { InvalidRequestError, objectBody } from '../validation.js';

export function registerAudioMigrationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(API_PATHS.audioMigration, async (_req, reply) => {
    ok(reply, audioMigrationReport(ctx) satisfies AudioMigrationData);
  });

  // Re-runs the whole pass, preflight included: the point of a retry is that
  // the machine changed, and the preflight is what looks at the machine.
  //
  // Kicked, not awaited. A pass over a real library takes minutes and this is a
  // button — the answer says "it is running again", and the progress screen
  // learns the rest from `/status`, which is the channel it is already polling.
  // So `counts` and `reason` here are as of this instant, not the outcome.
  app.post(API_PATHS.audioMigrationRetry, async (_req, reply) => {
    const migration = ctx.lifecycle.migration;
    // Not while the library is being served. A pass converting song directories
    // beside the download engine would move files nothing holds a claim on —
    // and there is nothing left for it to do anyway.
    const started = migration !== null && ctx.lifecycle.phase !== 'normal';
    if (started && migration !== null) {
      void migration.run().catch((err: unknown) => {
        ctx.logger.error({ err }, 'audio migration pass failed after a retry');
      });
    }

    ok(
      reply,
      {
        started,
        counts: audioMigrationCounts(ctx),
        reason: redactPaths(migration?.reason() ?? null),
      } satisfies AudioMigrationRetryData,
      started ? '已重新检测并继续迁移' : '迁移已经结束，无需重试',
    );
  });

  app.post(API_PATHS.audioMigrationBackupClear, async (req, reply) => {
    const body = objectBody(req.body, ['confirm']);
    // An explicit confirmation, not a header or a query flag: this deletes the
    // only copy of every `kept_unconverted` original, and the report says how
    // many of those there are precisely so the caller can show it first.
    if (body.confirm !== true) {
      throw new InvalidRequestError('INVALID_BODY', '清空迁移备份需要 confirm: true');
    }

    const migration = ctx.lifecycle.migration;
    const cleared = await (migration === null
      ? Promise.resolve(clearMigrationBackups(ctx.sqlite))
      : migration.exclusive(async () => clearMigrationBackups(ctx.sqlite)));

    ctx.logger.warn(cleared, 'audio migration backups cleared by request');
    ok(reply, cleared satisfies AudioMigrationBackupClearData, '迁移备份已清空');
  });
}
