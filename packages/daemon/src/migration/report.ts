// What the outside world is told about the audio migration (0.3.0 T3, §3.2-4).
//
// Two channels, and the split is about secrecy, not convenience:
//
//   `GET /status` is UNAUTHENTICATED — the one thing a GUI can read before it
//   holds a token. It carries counts and a state word. No paths, no filenames,
//   no ffmpeg text: a number cannot leak what a library contains.
//   `GET /api/audio-migration` (T3b) is authenticated and carries the per-object
//   detail, still with relative names only.

import { homedir } from 'node:os';
import { basename } from 'node:path';
import {
  countLedgerByStatus,
  listLedger,
  paths,
  realpathMissingOk,
  summarizeMigrationBackups,
} from '@lark/core';
import type {
  AudioMigrationCounts,
  AudioMigrationData,
  AudioMigrationObjectData,
} from '@lark/shared';
import type { BaseContext } from '../context.js';

/** The `/status` summary. Cheap enough for a probe that runs every second. */
export function audioMigrationCounts(ctx: BaseContext): AudioMigrationCounts {
  const counts = countLedgerByStatus(ctx.sqlite);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return {
    phase: ctx.lifecycle.phase,
    // No pass this boot means the library was already single-format. The counts
    // can still be non-zero: the ledger is kept as the report of the run that
    // did happen.
    state: ctx.lifecycle.migration?.state() ?? 'idle',
    total,
    done: counts.done ?? 0,
    lost: counts.lost ?? 0,
    kept_unconverted: counts.kept_unconverted ?? 0,
    asset_missing: counts.asset_missing ?? 0,
    blocked: counts.blocked ?? 0,
    blocked_file_op: counts.blocked_file_op ?? 0,
  };
}

/**
 * The authenticated report: every object, plus what the backup is holding.
 *
 * Still reachable once the migration is over — the ledger IS the report of what
 * happened to each file, and a user who wants to know why a song is gone should
 * not have to catch the daemon mid-conversion to find out (§3.2-4).
 */
export function audioMigrationReport(ctx: BaseContext): AudioMigrationData {
  return {
    counts: audioMigrationCounts(ctx),
    reason: redactPaths(ctx.lifecycle.migration?.reason() ?? null),
    objects: listLedger(ctx.sqlite).map(
      (row): AudioMigrationObjectData => ({
        object_key: row.object_key,
        song_id: row.song_id,
        class: row.class,
        status: row.status,
        file_origin: row.file_origin,
        blocked_action: row.blocked_action,
        error_class: row.error_class,
        last_error: redactPaths(row.last_error),
        // A NAME, not a path: the report says which file in the backup holds
        // this object's original, and the GUI opens the directory itself.
        backup_file: row.backup_path === null ? null : basename(row.backup_path),
        reconcile_action: row.reconcile_action,
        at: row.at,
      }),
    ),
    backup: summarizeMigrationBackups(ctx.sqlite),
  };
}

/**
 * Scrub absolute paths out of text bound for a client.
 *
 * The text comes from ffmpeg's stderr and from the preflight, both of which
 * quote real paths. `/status` never carries any of it, and this channel carries
 * names only — so the message survives, the location does not.
 */
export function redactPaths(text: string | null): string | null {
  if (text === null) return null;
  const lark = paths.larkDir();
  let scrubbed = text;
  for (const [path, placeholder] of [
    // Both spellings of the nest: on macOS the daemon's own `larkDir()` is
    // usually `/var/folders/…` while anything that touched the filesystem
    // reports `/private/var/…` for the same directory (M4 §8).
    [realpathMissingOk(lark), '<lark>'],
    [lark, '<lark>'],
    [homedir(), '~'],
  ] as const) {
    if (path !== '') scrubbed = scrubbed.split(path).join(placeholder);
  }
  return scrubbed;
}
