// The one-time mp3 → m4a migration, as the GUI sees it (0.3.0 T3c, §3.2-4).
//
// Two reads, and the difference between them is the whole design:
//
//   `GET /status` is unauthenticated, cheap, and answers even when nothing
//   else does. It carries the PHASE, which is what decides whether this window
//   shows the library at all — so it is polled, once a second, for as long as
//   the library is not being served.
//   `GET /api/audio-migration` carries the per-object detail and the backup
//   sizes. It is fetched when something is looking at it: the progress screen
//   while it is up, and the settings block when it is open.
//
// Nothing here subscribes to SSE. During the migration the GUI cannot register
// as the command channel (`POST /gui/register` is not on the whitelist — a
// player channel to a daemon that serves no audio would be a lie), so polling
// is not a fallback here, it is the channel.

import type {
  AudioMigrationBackupClearData,
  AudioMigrationCounts,
  AudioMigrationData,
  AudioMigrationRetryData,
  DaemonPhase,
  StatusData,
} from '@lark/shared';
import { API_PATHS, request } from '@lark/shared';
import { create } from 'zustand';
import { createLane } from '../lib/lanes.js';

const statusLane = createLane();
const reportLane = createLane();

/**
 * `unknown` until the first probe settles — including when it FAILS.
 *
 * A daemon that cannot be reached is not a migrating daemon: the window falls
 * through to the normal app, which has its own offline handling and has had it
 * since M4. Blocking the whole GUI on an unanswered probe would turn "the
 * daemon is starting" into "lark shows nothing".
 */
export type BootPhase = DaemonPhase | 'unknown';

interface MigrationState {
  phase: BootPhase;
  counts: AudioMigrationCounts | null;
  report: AudioMigrationData | null;
  /** True once a probe has come back, however it went. */
  probed: boolean;
  retrying: boolean;
  clearing: boolean;
  probe: () => Promise<void>;
  refreshReport: () => Promise<void>;
  /** Ask the daemon to re-check the machine and continue. */
  retry: () => Promise<AudioMigrationRetryData>;
  /** Delete every migration backup. The caller has already confirmed. */
  clearBackup: () => Promise<AudioMigrationBackupClearData>;
}

export const useMigration = create<MigrationState>((set) => ({
  phase: 'unknown',
  counts: null,
  report: null,
  probed: false,
  retrying: false,
  clearing: false,

  probe: async () => {
    const envelope = await statusLane
      .run((signal) => request<StatusData>('GET', API_PATHS.status, undefined, { signal }))
      .catch(() => null);
    if (envelope === null) {
      // Unreachable, or superseded by a newer probe. Either way this one has
      // nothing to say — but the first one has to mark the boot as settled or
      // the window would wait forever on a daemon that is not there.
      set({ probed: true });
      return;
    }
    const status = envelope.data;
    if (status === undefined) return;
    // A daemon older than 0.3 answers without the field. It cannot be
    // migrating — that concept did not exist — so it is serving.
    const counts = status.audio_migration ?? null;
    set({ phase: counts?.phase ?? 'normal', counts, probed: true });
  },

  refreshReport: async () => {
    const envelope = await reportLane
      .run((signal) =>
        request<AudioMigrationData>('GET', API_PATHS.audioMigration, undefined, { signal }),
      )
      .catch(() => null);
    // Shape-checked rather than trusted. This route may not exist on the daemon
    // that answered — a pre-0.3 one 404s, which the catch handles — but a 200
    // carrying something else would otherwise be rendered as a report and take
    // the settings page down with it.
    if (!isReport(envelope?.data)) return;
    set({ report: envelope.data, counts: envelope.data.counts });
  },

  retry: async () => {
    set({ retrying: true });
    try {
      const envelope = await request<AudioMigrationRetryData>(
        'POST',
        API_PATHS.audioMigrationRetry,
      );
      const result = envelope.data as AudioMigrationRetryData;
      set({ counts: result.counts });
      return result;
    } finally {
      set({ retrying: false });
    }
  },

  clearBackup: async () => {
    set({ clearing: true });
    try {
      const envelope = await request<AudioMigrationBackupClearData>(
        'POST',
        API_PATHS.audioMigrationBackupClear,
        { confirm: true },
      );
      return envelope.data as AudioMigrationBackupClearData;
    } finally {
      set({ clearing: false });
    }
  },
}));

/** The three fields every consumer of a report dereferences without checking. */
function isReport(value: unknown): value is AudioMigrationData {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AudioMigrationData>;
  return (
    typeof candidate.counts === 'object' &&
    candidate.counts !== null &&
    typeof candidate.backup === 'object' &&
    candidate.backup !== null &&
    Array.isArray(candidate.objects)
  );
}

/** How many objects have reached a terminal state — the progress numerator. */
export function settledCount(counts: AudioMigrationCounts): number {
  return counts.done + counts.lost + counts.kept_unconverted + counts.asset_missing;
}

/** Objects that cannot move without a person. */
export function attentionCount(counts: AudioMigrationCounts): number {
  return counts.blocked + counts.blocked_file_op;
}
