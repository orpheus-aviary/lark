// One object, start to finish (0.3.0 T2, master plan §3.2-5 / §3.2-7 / §3.2-9).
//
// This is the code that deletes a user's mp3, so two things shape all of it.
//
// The ledger is written BEFORE the thing it describes, never after. A row says
// `converting` while ffmpeg runs, `discarding` after the source was probed and
// before the unlink. A crash therefore always lands on a row that claims more
// than has happened, which is the safe direction: the next boot re-checks the
// disk and finds less than the row promised, not more.
//
// And the resume decision is taken from the DISK, not from the row. The
// reconciliation table (§3.2-9) is not a second implementation living beside
// the forward path — it IS the forward path: every step starts by asking what
// is in the directory and what is in the backup, so an interrupted run resumes
// by the same rules that got it there. The single exception is `discarding`,
// which records the one fact the disk cannot show: that a live probe already
// said this song can be downloaded again.

import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { type AudioProbe, probeAudio, processAudio } from '../download/ffmpeg.js';
import type { DownloadTimeouts } from '../download/timeouts.js';
import { CANONICAL_AUDIO_FILE, LEGACY_AUDIO_FILE } from '../library/lyrics.js';
import type { Logger } from '../logger/index.js';
import type { ResolvedMediaTools } from '../media-tools/resolve.js';
import { songsDir } from '../paths.js';
import { backupPathFor, moveWithoutOverwrite } from './backup.js';
import { classifyMigrationError } from './error-class.js';
import {
  type LedgerRow,
  type MigrationStatus,
  TERMINAL_STATUSES,
  updateLedgerRow,
} from './ledger.js';
import { assessCanonicalAudio } from './verify.js';

/** Temp names the pass writes, and sweeps before it starts over. */
const TMP_PREFIX = '.song.migration';

export interface ConverterContext {
  sqlite: BetterSqlite3.Database;
  tools: ResolvedMediaTools;
  /**
   * Is this source still downloadable? (§4-h)
   *
   * Injected rather than imported: it is the cache eviction's own probe (R26 —
   * one implementation of "can we get this back", not two), and that lives
   * behind the daemon's bilibili client, which core must not depend on.
   */
  canRedownload: (sourceKey: string, signal?: AbortSignal) => Promise<boolean>;
  signal?: AbortSignal;
  logger?: Logger;
  timeouts?: DownloadTimeouts;
  nowMs?: () => number;
}

export type StepResult =
  /** The object reached a terminal state. */
  | { kind: 'settled'; status: MigrationStatus }
  /** A file action failed: this object needs a person, the pass goes on. */
  | { kind: 'blocked'; message: string }
  /** The machine is the problem: the pass stops and touches nothing else. */
  | { kind: 'environment'; message: string }
  /** Teardown or cancellation. The row stays where it was. */
  | { kind: 'aborted' }
  /** Nothing to do (a file op owns it, or it was already finished). */
  | { kind: 'skipped' };

interface ObjectPaths {
  dir: string;
  mp3: string;
  m4a: string;
  tmp: string;
  backup: string;
  backupRelative: string;
}

function pathsFor(row: LedgerRow): ObjectPaths {
  const key = row.object_key;
  // The key comes from a directory listing, but it round-trips through the
  // database — so it is checked again before it is joined onto a path.
  if (key === '' || key.includes('/') || key.includes('\\') || key.includes('..')) {
    throw new Error(`refusing to touch a migration object named ${JSON.stringify(key)}`);
  }
  const dir = join(songsDir(), key);
  const backup = backupPathFor(key, row.class === 'orphan');
  return {
    dir,
    mp3: join(dir, LEGACY_AUDIO_FILE),
    m4a: join(dir, CANONICAL_AUDIO_FILE),
    tmp: join(dir, `${TMP_PREFIX}.m4a.tmp`),
    backup: backup.absolute,
    backupRelative: backup.relative,
  };
}

/**
 * Advance one object as far as it goes in one call.
 *
 * Never throws for anything the caller can act on: a failure comes back as
 * `blocked` (this object) or `environment` (the machine), because the runner's
 * response to those is different and an exception cannot say which it is.
 */
export async function stepObject(ctx: ConverterContext, row: LedgerRow): Promise<StepResult> {
  const now = ctx.nowMs ?? Date.now;
  const paths = pathsFor(row);
  const settle = (status: MigrationStatus, update = {}): StepResult => {
    updateLedgerRow(ctx.sqlite, row.object_key, { status, ...update }, now());
    return { kind: 'settled', status };
  };

  if (row.status === 'blocked_file_op') return { kind: 'skipped' };

  // A finished object that has an mp3 again: something put it back — a
  // restored backup, a user copying files around. It is not deleted and it
  // does not reopen the object; it is moved somewhere safe and reported, so
  // that "no mp3 under songs/" can still become true (§3.2-13).
  if (TERMINAL_STATUSES.includes(row.status)) {
    if (!existsSync(paths.mp3)) return { kind: 'skipped' };
    return reconcileStrayMp3(ctx, row, paths, now);
  }

  sweepTemp(paths.dir);

  // The one state the disk cannot reconstruct: the probe already happened.
  if (row.status === 'discarding') {
    const removed = tryFileAction(ctx, row, 'unlink_mp3', () => {
      if (existsSync(paths.mp3)) unlinkSync(paths.mp3);
    });
    return removed ?? settle('lost');
  }

  if (!existsSync(paths.mp3)) return await settleWithoutSource(ctx, row, paths, settle);

  // ─── The mp3 is there ───
  const existingM4a = existsSync(paths.m4a) ? await inspect(ctx, paths.m4a, row) : null;
  if (existingM4a !== null && !existingM4a.ok) {
    // A conversion that did not finish. Its output is not evidence of anything.
    const failed = tryFileAction(ctx, row, 'unlink_m4a', () => unlinkSync(paths.m4a));
    if (failed !== null) return failed;
  }
  if (existingM4a?.ok === true) return await finishConverted(ctx, row, paths, settle);

  if (row.class === 'orphan') {
    // Nothing points at this audio, so converting it would produce a file no
    // row can serve. Park it and leave the tree clean.
    return await backUpAndSettle(ctx, row, paths, 'kept_unconverted', settle);
  }

  updateLedgerRow(ctx.sqlite, row.object_key, { status: 'converting' }, now());
  const conversion = await convert(ctx, paths);
  if (conversion.kind !== 'ok') {
    if (conversion.kind === 'aborted') {
      updateLedgerRow(
        ctx.sqlite,
        row.object_key,
        { status: 'pending', error_class: 'abort' },
        now(),
      );
      return { kind: 'aborted' };
    }
    if (conversion.kind === 'environment') {
      updateLedgerRow(
        ctx.sqlite,
        row.object_key,
        { status: 'pending', error_class: 'environment', last_error: conversion.message },
        now(),
      );
      return { kind: 'environment', message: conversion.message };
    }
    return await handleUnreadable(ctx, row, paths, conversion.message, settle);
  }

  const landed = tryFileAction(ctx, row, 'rename_m4a', () => renameSync(paths.tmp, paths.m4a));
  if (landed !== null) return landed;
  return await finishConverted(ctx, row, paths, settle);
}

type Settle = (status: MigrationStatus, update?: Record<string, unknown>) => StepResult;

/**
 * The m4a is in place and valid. R's mp3 is now redundant; A's is an asset
 * that has to survive somewhere else first.
 */
async function finishConverted(
  ctx: ConverterContext,
  row: LedgerRow,
  paths: ObjectPaths,
  settle: Settle,
): Promise<StepResult> {
  if (row.class === 'R') {
    const failed = tryFileAction(ctx, row, 'unlink_mp3', () => {
      if (existsSync(paths.mp3)) unlinkSync(paths.mp3);
    });
    return failed ?? settle('done', { error_class: null, last_error: null });
  }
  return await backUpAndSettle(ctx, row, paths, 'done', settle);
}

/**
 * Move the mp3 into `migration-backup/` and settle.
 *
 * `backing_up` is written first and carries where it was heading, so the
 * report can say what a crashed run had decided — the resume itself reads the
 * disk, which cannot be out of date with itself.
 */
async function backUpAndSettle(
  ctx: ConverterContext,
  row: LedgerRow,
  paths: ObjectPaths,
  intent: 'done' | 'kept_unconverted',
  settle: Settle,
): Promise<StepResult> {
  const now = ctx.nowMs ?? Date.now;
  updateLedgerRow(
    ctx.sqlite,
    row.object_key,
    { status: 'backing_up', resume_state: intent },
    now(),
  );

  let reconcile: string | null = null;
  const failed = tryFileAction(ctx, row, 'backup_mp3', () => {
    const outcome = moveWithoutOverwrite(paths.mp3, paths.backup);
    if (outcome.kind === 'diverted') {
      reconcile = `备份里已有同名但内容不同的文件，这一份存到了 ${outcome.target}`;
    }
  });
  if (failed !== null) return failed;

  // The terminal state is only written once the file is provably somewhere
  // else. An `asset_missing` here would be a lie in the other direction, so it
  // is checked rather than assumed.
  if (!existsSync(paths.backup) && reconcile === null) {
    return settle('asset_missing', { last_error: '备份文件在移动之后不存在' });
  }
  return settle(intent, {
    backup_path: paths.backupRelative,
    reconcile_action: reconcile,
    ...(intent === 'done' ? { error_class: null, last_error: null } : {}),
  });
}

/**
 * ffmpeg could not read this mp3 (§3.2-7).
 *
 * R may discard it — but only after asking, right now, whether the source
 * still answers. A no, or an unreachable network, sends it down A's path
 * instead: an unreadable file that cannot be re-fetched is still the only copy
 * there is.
 */
async function handleUnreadable(
  ctx: ConverterContext,
  row: LedgerRow,
  paths: ObjectPaths,
  message: string,
  settle: Settle,
): Promise<StepResult> {
  const now = ctx.nowMs ?? Date.now;
  updateLedgerRow(
    ctx.sqlite,
    row.object_key,
    { error_class: 'content', last_error: message },
    now(),
  );

  if (row.class === 'R' && (await sourceStillAnswers(ctx, row))) {
    updateLedgerRow(ctx.sqlite, row.object_key, { status: 'discarding' }, now());
    const failed = tryFileAction(ctx, row, 'unlink_mp3', () => unlinkSync(paths.mp3));
    return failed ?? settle('lost');
  }
  return await backUpAndSettle(ctx, row, paths, 'kept_unconverted', settle);
}

async function sourceStillAnswers(ctx: ConverterContext, row: LedgerRow): Promise<boolean> {
  if (row.song_id === null || row.source_key_present !== 1) return false;
  const song = ctx.sqlite.prepare('SELECT source_key FROM songs WHERE id = ?').get(row.song_id) as
    | { source_key: string | null }
    | undefined;
  if (song?.source_key === null || song?.source_key === undefined) return false;
  try {
    return await ctx.canRedownload(song.source_key, ctx.signal);
  } catch (err) {
    // No network, a rate limit, a bad response: none of them are permission to
    // delete the only copy of something.
    ctx.logger?.warn(
      { object_key: row.object_key, err: err instanceof Error ? err.message : String(err) },
      'audio migration could not verify the source; keeping the file',
    );
    return false;
  }
}

/** The mp3 is gone. What is left decides whether that was fine (§3.2-9). */
async function settleWithoutSource(
  ctx: ConverterContext,
  row: LedgerRow,
  paths: ObjectPaths,
  settle: Settle,
): Promise<StepResult> {
  const m4a = existsSync(paths.m4a) ? await inspect(ctx, paths.m4a, row) : null;
  if (m4a !== null && !m4a.ok) {
    const failed = tryFileAction(ctx, row, 'unlink_m4a', () => unlinkSync(paths.m4a));
    if (failed !== null) return failed;
  }
  const converted = m4a?.ok === true;
  const backedUp = existsSync(paths.backup);

  if (row.class === 'R') {
    // R's content is either in the m4a or downloadable again; either way
    // nothing was lost that this pass has to keep looking for.
    return converted ? settle('done') : settle('lost');
  }
  // An asset's original is not replaceable by its conversion — the conversion
  // is lossy and was never the thing being kept. So a missing backup is
  // `asset_missing` even when a perfectly good m4a is sitting right there, and
  // that row NEVER reads as done (§3.2-9).
  if (!backedUp) {
    return settle('asset_missing', { last_error: '源文件不见了，备份里也没有' });
  }
  return settle(converted ? 'done' : 'kept_unconverted', { backup_path: paths.backupRelative });
}

/** A finished object grew an mp3 again: keep it, report it, clear the tree. */
function reconcileStrayMp3(
  ctx: ConverterContext,
  row: LedgerRow,
  paths: ObjectPaths,
  now: () => number,
): StepResult {
  let note = '';
  const failed = tryFileAction(ctx, row, 'reconcile_mp3', () => {
    const outcome = moveWithoutOverwrite(paths.mp3, paths.backup);
    note = `迁移完成后又出现了 mp3，已移到 ${outcome.target}`;
  });
  if (failed !== null) return failed;
  updateLedgerRow(ctx.sqlite, row.object_key, { reconcile_action: note }, now());
  return { kind: 'settled', status: row.status };
}

type ConversionOutcome =
  | { kind: 'ok' }
  | { kind: 'content'; message: string }
  | { kind: 'environment'; message: string }
  | { kind: 'aborted' };

/** Probe, transcode, and check the result actually holds the song. */
async function convert(ctx: ConverterContext, paths: ObjectPaths): Promise<ConversionOutcome> {
  const options = { signal: ctx.signal, timeouts: ctx.timeouts };
  let source: AudioProbe;
  try {
    source = await probeAudio(ctx.tools.ffprobe.path, paths.mp3, options);
    if (source.selected_stream_global_index < 0) {
      return { kind: 'content', message: '文件里没有音频流' };
    }
    await processAudio(ctx.tools.ffmpeg.path, paths.mp3, paths.tmp, source, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = classifyMigrationError(err, 'convert', ctx.signal);
    if (kind === 'abort') return { kind: 'aborted' };
    // `file_action` cannot come out of the convert step; naming the two that
    // can keeps that a fact rather than an assumption.
    return { kind: kind === 'content' ? 'content' : 'environment', message };
  }

  // ffmpeg exits 0 on a truncated mp3 and writes a valid, SHORTER m4a — see
  // 附表 A.4. Without this the pass would delete the original and keep half
  // the song.
  try {
    const result = await probeAudio(ctx.tools.ffprobe.path, paths.tmp, options);
    const verdict = assessCanonicalAudio(result, source.duration);
    return verdict.ok ? { kind: 'ok' } : { kind: 'content', message: verdict.reason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = classifyMigrationError(err, 'convert', ctx.signal);
    if (kind === 'abort') return { kind: 'aborted' };
    // `file_action` cannot come out of the convert step; naming the two that
    // can keeps that a fact rather than an assumption.
    return { kind: kind === 'content' ? 'content' : 'environment', message };
  }
}

interface Inspection {
  ok: boolean;
}

/**
 * Is this m4a a finished conversion of this object's song?
 *
 * The length to compare against comes from the library row, since the mp3 may
 * be gone by the time this is asked. A song with no recorded duration skips
 * that check rather than guessing (§附表 A.5).
 */
async function inspect(ctx: ConverterContext, path: string, row: LedgerRow): Promise<Inspection> {
  const expected =
    row.song_id === null
      ? null
      : ((
          ctx.sqlite.prepare('SELECT duration FROM songs WHERE id = ?').get(row.song_id) as
            | { duration: number }
            | undefined
        )?.duration ?? null);
  try {
    const probe = await probeAudio(ctx.tools.ffprobe.path, path, {
      signal: ctx.signal,
      timeouts: ctx.timeouts,
    });
    return { ok: assessCanonicalAudio(probe, expected === 0 ? null : expected).ok };
  } catch {
    // Unreadable is exactly what "not a finished conversion" looks like.
    return { ok: false };
  }
}

/**
 * Run a file action, turning its failure into a `blocked` row.
 *
 * Returns null when it worked — so a caller reads `?? next` and cannot forget
 * to check.
 */
function tryFileAction(
  ctx: ConverterContext,
  row: LedgerRow,
  action: string,
  step: () => void,
): StepResult | null {
  try {
    step();
    return null;
  } catch (err) {
    const now = ctx.nowMs ?? Date.now;
    const message = err instanceof Error ? err.message : String(err);
    const kind = classifyMigrationError(err, 'file_action', ctx.signal);
    if (kind === 'abort') return { kind: 'aborted' };
    if (kind === 'environment') {
      updateLedgerRow(
        ctx.sqlite,
        row.object_key,
        { error_class: 'environment', last_error: message },
        now(),
      );
      return { kind: 'environment', message };
    }
    updateLedgerRow(
      ctx.sqlite,
      row.object_key,
      {
        status: 'blocked',
        blocked_action: action,
        error_class: 'file_action',
        last_error: message,
      },
      now(),
    );
    return { kind: 'blocked', message };
  }
}

/** Drop this pass's leftover temp output before starting over. */
function sweepTemp(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* a temp file that will not go is not worth failing an object over */
    }
  }
}

/** Bytes the largest single mp3 would need to convert with room to spare. */
export function largestMp3Bytes(sqlite: BetterSqlite3.Database): number {
  const rows = sqlite.prepare('SELECT object_key FROM audio_migration').all() as {
    object_key: string;
  }[];
  let largest = 0;
  for (const { object_key } of rows) {
    try {
      largest = Math.max(largest, statSync(join(songsDir(), object_key, LEGACY_AUDIO_FILE)).size);
    } catch {
      /* gone or unreadable: the step for that object will say so */
    }
  }
  return largest;
}
