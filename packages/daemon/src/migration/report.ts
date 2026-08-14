// What the outside world is told about the audio migration (0.3.0 T3, §3.2-4).
//
// Two channels, and the split is about secrecy, not convenience:
//
//   `GET /status` is UNAUTHENTICATED — the one thing a GUI can read before it
//   holds a token. It carries counts and a state word. No paths, no filenames,
//   no ffmpeg text: a number cannot leak what a library contains.
//   `GET /api/audio-migration` (T3b) is authenticated and carries the per-object
//   detail, still with relative names only.

import { countLedgerByStatus } from '@lark/core';
import type { AudioMigrationCounts } from '@lark/shared';
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
