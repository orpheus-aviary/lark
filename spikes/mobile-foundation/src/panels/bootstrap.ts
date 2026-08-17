// A fresh mobile library, rehearsed (N0b-2, criterion 15).
//
// The contract's migration group proves host parity — same chain, same schema
// signature, same fail-closed behaviour. This is the other half: the sequence a
// mobile bootstrap will actually run, ending in the assertion that matters to
// N2. `audio_migration_pending` is set by 0003 for EVERY library that reaches
// v3, because 0003 cannot know what is in `songs/`. A fresh phone has no
// `songs/` at all, so it must clear the flag — through
// `clearAudioMigrationPending`, not a hand-written UPDATE (decision j). A
// mobile client that skipped this would sit behind a migration gate waiting for
// mp3 files that never existed.

import {
  AUDIO_MIGRATION_PENDING_KEY,
  LATEST_KNOWN_VERSION,
  applyForwardMigrations,
  assertCurrentSchema,
  clearAudioMigrationPending,
  isAudioMigrationPending,
} from '@lark/core/portable';
import type { ContractHooks } from '@lark/core/portable';

export interface BootstrapStep {
  name: string;
  ok: boolean;
  detail: string;
}

export function rehearseFreshLibrary(hooks: ContractHooks): BootstrapStep[] {
  const steps: BootstrapStep[] = [];
  const db = hooks.open();

  const record = (name: string, fn: () => string): void => {
    try {
      steps.push({ name, ok: true, detail: fn() });
    } catch (err) {
      steps.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  try {
    const sqlite = db.sqlite;

    record('starts empty', () => {
      const v = sqlite.pragma('user_version', { simple: true });
      if (v !== 0) throw new Error(`user_version is ${String(v)}, expected 0`);
      return 'user_version 0';
    });

    record('chain 0001 → 0003', () => {
      applyForwardMigrations(sqlite, 0, LATEST_KNOWN_VERSION);
      const v = sqlite.pragma('user_version', { simple: true });
      if (v !== LATEST_KNOWN_VERSION) {
        throw new Error(`user_version is ${String(v)}, expected ${LATEST_KNOWN_VERSION}`);
      }
      return `user_version ${LATEST_KNOWN_VERSION}`;
    });

    record('assertCurrentSchema', () => {
      assertCurrentSchema(sqlite, 'mobile-bootstrap.db');
      return 'the signature matches';
    });

    record('0003 leaves the audio migration owed', () => {
      if (!isAudioMigrationPending(sqlite)) {
        throw new Error('the flag was not set — 0003 changed, or the read is wrong');
      }
      return `${AUDIO_MIGRATION_PENDING_KEY} = '1'`;
    });

    record('bootstrap clears it (real implementation)', () => {
      clearAudioMigrationPending(sqlite);
      if (isAudioMigrationPending(sqlite)) throw new Error('still pending after the clear');
      const row = sqlite
        .prepare('SELECT value FROM local_metadata WHERE key = ?')
        .get(AUDIO_MIGRATION_PENDING_KEY) as { value: string } | undefined;
      if (row?.value !== '0') {
        throw new Error(`row is ${JSON.stringify(row)}, expected value '0' (kept, not deleted)`);
      }
      return `${AUDIO_MIGRATION_PENDING_KEY} = '0'`;
    });

    record('survives a reopen', () => {
      const reopened = db.reopen();
      const v = reopened.pragma('user_version', { simple: true });
      if (v !== LATEST_KNOWN_VERSION) throw new Error(`user_version is ${String(v)} after reopen`);
      if (isAudioMigrationPending(reopened)) throw new Error('pending came back after reopen');
      assertCurrentSchema(reopened, 'mobile-bootstrap.db');
      return `user_version ${LATEST_KNOWN_VERSION}, not pending`;
    });
  } finally {
    db.cleanup();
  }

  return steps;
}
