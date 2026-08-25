// One sync round, with everything the daemon has to do around it (v0.2 T3c).
//
// core's `runSync` does the protocol. This file does the consequences:
//
//   the STATE machine — idle / syncing / offline / error / auth_required, and
//     the rule that a round which finished after its session was replaced
//     changes none of it (the epoch check),
//   the EVENTS — a pull that applied something has to tell the GUI, or the
//     library on screen silently disagrees with the library on disk,
//   the JUDGEMENT after a failure — whose problem is it, and does trying again
//     help (`classifySyncFailure`),
//   and the housekeeping the round is a convenient moment for (retention).
//
// The auth failure path deliberately does NOT call `teardownSession`: that
// waits for the round in flight to unwind, and the round in flight is this
// one. `dropSession` bumps the epoch and returns.

import { SyncAuthRequiredError } from '../errors.js';
import { countUnresolvedConflicts } from '../sync/conflicts.js';
import { type RunSyncResult, runSync } from '../sync/engine.js';
import { RETENTION_MS, runRetention } from '../sync/retention.js';
import { classifySyncFailure } from '../sync/retry.js';
import type { CoordinatorContext } from './context.js';

/**
 * What asked for this round. Only ever used for the log line.
 *
 * `resume` is the phone's (N5d): an app coming back to the foreground is the
 * moment a device that has been asleep catches up, and it is neither a boot
 * nor a clock tick. The daemon never emits it — nothing on a desktop goes away
 * and comes back.
 */
export type SyncTrigger = 'manual' | 'scheduler' | 'outbox' | 'remote' | 'boot' | 'resume';

/** Trim the outbox at most this often; the round is just when we notice. */
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export interface RunRoundOptions {
  triggers: readonly SyncTrigger[];
  signal: AbortSignal;
}

/**
 * Run one round against the current session.
 *
 * Throws `SYNC_AUTH_REQUIRED` when there is no session — `POST /sync/run` says
 * exactly that to the caller, and the background triggers check first so they
 * never produce it.
 */
export async function runSyncRound(
  ctx: CoordinatorContext,
  options: RunRoundOptions,
): Promise<RunSyncResult> {
  const session = ctx.sync.session;
  if (session === null) throw new SyncAuthRequiredError();

  const epoch = ctx.sync.epoch;
  ctx.sync.noteSyncing();
  emitStatus(ctx);

  try {
    const result = await runSync({
      sqlite: ctx.db.sqlite,
      client: session.client,
      serverId: session.serverId,
      workspaceId: session.workspaceId,
      fileOps: ctx.fileOps,
      logger: ctx.logger,
      signal: options.signal,
      nowMs: ctx.now,
      pullLimit: ctx.pullLimit,
    });

    // A login or a logout replaced the session while this was in flight. Its
    // result describes a session nobody is talking to any more; reporting it
    // as the current state would overwrite what that lifecycle change set.
    if (ctx.sync.isStale(epoch)) return result;

    ctx.sync.noteSuccess(ctx.now());
    announce(ctx, result);
    maybeTrimOutbox(ctx);
    emitStatus(ctx);

    ctx.logger.info(
      {
        triggers: [...options.triggers],
        pulled: result.pulled,
        pushed: result.pushed,
        applied: result.applied,
        skipped: result.skipped,
        dead_lettered: result.deadLettered,
        conflicts: result.conflicts,
        cancelled: result.cancelled,
      },
      'sync round finished',
    );
    return result;
  } catch (err) {
    if (ctx.sync.isStale(epoch)) throw err;

    const failure = classifySyncFailure(err);
    if (failure.kind === 'auth') {
      // Not a teardown: this IS the round a teardown would wait for.
      ctx.sync.dropSession('token_rejected');
      ctx.sync.lastError = failure.message;
    } else if (failure.kind === 'permanent') {
      ctx.sync.noteError(failure.message);
    } else {
      // No status at all means the transport failed, which is the one failure
      // a user reads as "offline" rather than "something is wrong".
      if (failure.status === undefined) ctx.sync.noteOffline(failure.message);
      else ctx.sync.noteError(failure.message);
    }
    emitStatus(ctx);

    ctx.logger.warn(
      { err, kind: failure.kind, status: failure.status, triggers: [...options.triggers] },
      'sync round failed',
    );
    throw err;
  }
}

export function emitStatus(ctx: CoordinatorContext): void {
  ctx.events.emit({ type: 'sync:status_changed', state: ctx.sync.state });
}

/**
 * Tell the front-ends what a pull changed.
 *
 * Same event types the local write paths emit, on purpose: a song that
 * changed because another device edited it is not a different kind of change
 * to a GUI, and inventing sync-specific events would double every listener.
 */
function announce(ctx: CoordinatorContext, result: RunSyncResult): void {
  if (result.applied > 0) {
    if (result.songsTouched) ctx.events.emit({ type: 'songs:changed' });
    if (result.playlistsTouched) ctx.events.emit({ type: 'playlists:changed' });
    for (const songId of new Set(result.lyricsTouched)) {
      ctx.events.emit({ type: 'lyrics:changed', song_id: songId });
    }
  }
  if (result.conflicts > 0) {
    ctx.events.emit({
      type: 'conflicts:changed',
      count: countUnresolvedConflicts(ctx.db.sqlite),
    });
  }
}

/**
 * Drop settled changes older than the horizon, at most once an hour.
 *
 * Per round would be wasteful — the DELETE walks the outbox — and per boot
 * would never fire on a daemon that runs for weeks, which is the normal case.
 */
function maybeTrimOutbox(ctx: CoordinatorContext): void {
  const now = ctx.now();
  const last = ctx.sync.lastRetentionAt;
  if (last !== null && now - last < RETENTION_INTERVAL_MS) return;
  ctx.sync.lastRetentionAt = now;
  const trimmed = runRetention(ctx.db.sqlite, { nowMs: now });
  if (trimmed.removed > 0) {
    ctx.logger.info(
      { removed: trimmed.removed, before: trimmed.before, retention_ms: RETENTION_MS },
      'sync outbox trimmed',
    );
  }
}
