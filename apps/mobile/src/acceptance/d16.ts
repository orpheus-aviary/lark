// D16's acceptance scenarios (criteria 17, 18, 19), run on the device.
//
// FIXTURES ARE SYNTHESISED HERE, NOT PUSHED. Decision o④ describes an
// `adb push` + import channel because `Paths.document` cannot be written from
// outside the app — and that is still true, and still needed for criterion
// 14's real desktop library (N2f). But none of D16's own criteria need a
// FOREIGN library file: they need a library this install does not have the
// identity for, and the faithful way to produce one is to make a real library
// through the real path and then take the identity away. That is what a
// restore does. Pushing a file would test the import channel as much as the
// gate.
//
// CRASHES ARE THROWN, NOT KILLED, and the gap is worth stating rather than
// glossing. Everything the sequence writes before a crash point is durable by
// the time the point is reached — SQLite has committed, SecureStore's writes
// are synchronous — so a throw leaves the same PERSISTED state a `kill -9`
// would, at a point chosen precisely instead of guessed at (which is what
// decision o⑤ asks for and what `am force-stop` cannot give).
//
// The one thing a throw does that a kill does not: it unwinds, and the
// sequence closes its handle on the way out. A real death leaves the handle
// open and possibly a hot WAL. That difference is covered elsewhere rather
// than here — N0b-5a measured copy-then-open against a 4MB hot WAL, and
// SQLite recovers a WAL on the next open by design — but it IS a difference,
// and these scenarios do not exercise it.
//
// Where it will start to matter is N2d: a death in the middle of the file-op
// drain leaves half a file operation, which is not a database state at all.
// That batch's criterion 12③ is where a real process kill has to earn its
// place.

import { type PortableDb, ensureDeviceUuid } from '@lark/core/portable';
import { File } from 'expo-file-system';
import { openDatabaseSync } from 'expo-sqlite';
import { type BootCrashPoint, type BootResult, runBootSequence } from '../boot/sequence';
import { portableDbOf } from '../db/portable-db';
import { INSTALL_ID_KEY } from '../identity/snapshot';
import { forgetIdentity, readCommitted } from '../identity/store';
import { createSecureCredentialStore } from '../ports/credentials';
import { DATABASE_NAME, nestDirectory } from '../ports/paths';

export interface ScenarioRow {
  name: string;
  ok: boolean;
  detail: string;
}

// ─── fixture plumbing ───────────────────────────────────

/** Every trace of an install: the library, its sidecars, both SecureStore keys. */
async function resetInstall(): Promise<void> {
  for (const part of ['', '-wal', '-shm']) {
    const file = new File(nestDirectory(), `${DATABASE_NAME}${part}`);
    if (file.exists) file.delete();
  }
  await forgetIdentity();
}

/** Open the library outside the boot sequence, to seed or inspect it. */
function withLibrary<T>(body: (db: PortableDb) => T): T {
  const handle = openDatabaseSync(DATABASE_NAME, {}, nestDirectory().uri);
  try {
    return body(portableDbOf(handle));
  } finally {
    handle.closeSync();
  }
}

const readMeta = (db: PortableDb, key: string): string | null =>
  (
    db.sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(key) as
      | { value: string }
      | undefined
  )?.value ?? null;

const writeMeta = (db: PortableDb, key: string, value: string): void => {
  db.sqlite
    .prepare('INSERT OR REPLACE INTO local_metadata (key, value) VALUES (?, ?)')
    .run(key, value);
};

const backfillTarget = (db: PortableDb): number =>
  Number(readMeta(db, 'sync_backfill_target_generation') ?? '0');

const countRows = (db: PortableDb, table: string): number =>
  (db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/**
 * The state a converge is supposed to clear, planted so that "it cleared it"
 * is observable rather than assumed — plus one `sync_file_ops` row, which it
 * is supposed to LEAVE.
 */
function plantForeignState(db: PortableDb): void {
  db.sqlite
    .prepare(
      `INSERT INTO sync_binding (id, server_id, user_id, workspace_id, schema_version, bound_at)
       VALUES (1, 'server-x', 'user-x', 'ws-x', 1, 1)`,
    )
    .run();
  db.sqlite
    .prepare(
      'INSERT INTO sync_file_ops (kind, song_id, arg, created_at) VALUES (\'delete_song_files\', \'song-x\', \'{"op_uuid":"op-x","policy":"local"}\', 1)',
    )
    .run();
  writeMeta(db, 'skybridge_device_id', 'device-x');
  createSecureCredentialStore().write({ server: { url: 'https://example.invalid' } });
}

async function boot(crashAt?: BootCrashPoint): Promise<BootResult> {
  return runBootSequence({
    crashPoint: crashAt
      ? (point) => {
          if (point === crashAt) throw new Error(`crash-point:${point}`);
        }
      : undefined,
  });
}

/** Boot, read what we need, close. Nothing here may leave a handle open. */
async function bootAndClose<T>(read: (result: BootResult) => T): Promise<T> {
  const result = await boot();
  try {
    return read(result);
  } finally {
    result.handle.closeSync();
  }
}

/** Boot expecting the hook to throw; report whether it did. */
async function bootExpectingCrash(at: BootCrashPoint): Promise<boolean> {
  try {
    const result = await boot(at);
    result.handle.closeSync();
    return false;
  } catch (err) {
    return err instanceof Error && err.message === `crash-point:${at}`;
  }
}

// ─── scenarios ──────────────────────────────────────────

type Scenario = () => Promise<string>;

/** Criterion 17: only the database came back. SecureStore did not. */
const restoredLibrary: Scenario = async () => {
  await resetInstall();
  const first = await bootAndClose((r) => ({ install: r.installId, uuid: r.deviceUuid }));

  // The restore: the file survives, the Keystore entries do not.
  await forgetIdentity();

  const second = await boot();
  try {
    if (second.decision.action !== 'converge') {
      throw new Error(`decided '${second.decision.action}', expected converge (fail-closed)`);
    }
    if (second.installId === first.install) throw new Error('kept the old install_id');
    // Criterion 19⑤ — two installs must not share one local identity.
    if (second.deviceUuid === first.uuid) throw new Error('device_uuid was not rebuilt');
    return `converge · install ${first.install.slice(0, 8)}… → ${second.installId.slice(0, 8)}… · device_uuid rebuilt`;
  } finally {
    second.handle.closeSync();
  }
};

/** Criterion 18: both sides present, and they disagree. */
const mismatchedIdentity: Scenario = async () => {
  await resetInstall();
  await bootAndClose(() => undefined);

  withLibrary((db) => writeMeta(db, INSTALL_ID_KEY, 'somebody-elses-install'));

  const result = await boot();
  try {
    if (result.decision.action !== 'converge') {
      throw new Error(`decided '${result.decision.action}', expected converge`);
    }
    if (readCommitted() !== result.installId) throw new Error('SecureStore was not updated');
    return `converge · ${result.decision.reason}`;
  } finally {
    result.handle.closeSync();
  }
};

/** Criterion 19③: the fresh path's two crash points. */
function freshCrash(at: BootCrashPoint): Scenario {
  return async () => {
    await resetInstall();
    if (!(await bootExpectingCrash(at))) throw new Error(`the hook at ${at} did not fire`);

    const result = await boot();
    try {
      // Whatever it decides, it must NOT have treated its own half-built
      // library as somebody else's and wiped it — that was v2's bug, and the
      // observable form of it is a converge on the retry.
      if (result.converged !== null) {
        throw new Error('it converged its own fresh library');
      }
      const committed = readCommitted();
      if (committed !== result.installId) {
        throw new Error(`SecureStore says ${String(committed)}, boot says ${result.installId}`);
      }
      const dbSide = readMeta(result.db, INSTALL_ID_KEY);
      if (dbSide !== result.installId) {
        throw new Error(`the library says ${String(dbSide)}`);
      }
      return `resumed as '${result.decision.action}', both sides ${result.installId.slice(0, 8)}…`;
    } finally {
      result.handle.closeSync();
    }
  };
}

/** Criterion 19④ and ⑥: the converge path's three crash points. */
function convergeCrash(at: BootCrashPoint): Scenario {
  return async () => {
    await resetInstall();
    await bootAndClose(() => undefined);
    withLibrary(plantForeignState);
    const before = withLibrary((db) => ({
      target: backfillTarget(db),
      fileOps: countRows(db, 'sync_file_ops'),
    }));
    // Make the next boot a converge.
    await forgetIdentity();

    if (!(await bootExpectingCrash(at))) throw new Error(`the hook at ${at} did not fire`);

    const result = await boot();
    try {
      const db = result.db;
      if (countRows(db, 'sync_binding') !== 0) throw new Error('the binding survived');
      if (readMeta(db, 'skybridge_device_id') !== null) {
        throw new Error('a skybridge identity survived');
      }
      if (createSecureCredentialStore().read() !== null) {
        throw new Error('the credentials survived');
      }
      // Criterion 19⑥: the journal is the boot drain's, not converge's.
      const fileOps = countRows(db, 'sync_file_ops');
      if (fileOps !== before.fileOps) {
        throw new Error(`sync_file_ops went ${before.fileOps} → ${fileOps}`);
      }
      // "Cleared once, not twice" — the only observable difference between one
      // converge and two, because every clear is idempotent but the backfill
      // bump is not.
      const target = backfillTarget(db);
      if (target !== before.target + 1) {
        throw new Error(`backfill target ${before.target} → ${target}, expected exactly one bump`);
      }
      return `converged once · file ops kept ${fileOps} · backfill ${before.target} → ${target}`;
    } finally {
      result.handle.closeSync();
    }
  };
}

/**
 * Criterion 8's mobile third case, and the one thing `resetInstall` cannot
 * fake: after a converge, asking for the identity again is idempotent.
 */
const convergedIsStable: Scenario = async () => {
  await resetInstall();
  await bootAndClose(() => undefined);
  await forgetIdentity();
  const converged = await bootAndClose((r) => ({ install: r.installId, uuid: r.deviceUuid }));

  const again = await boot();
  try {
    if (again.decision.action !== 'normal') {
      throw new Error(`decided '${again.decision.action}' the launch after a converge`);
    }
    if (again.installId !== converged.install) throw new Error('the install_id moved');
    if (again.deviceUuid !== converged.uuid) throw new Error('the device_uuid moved');
    if (ensureDeviceUuid(again.db.sqlite) !== converged.uuid) {
      throw new Error('ensureDeviceUuid is not idempotent on a converged library');
    }
    return `normal · ${converged.install.slice(0, 8)}… stable`;
  } finally {
    again.handle.closeSync();
  }
};

const SCENARIOS: { name: string; run: Scenario }[] = [
  { name: '17 · restored library, no Keystore → converge', run: restoredLibrary },
  { name: '18 · install_id mismatch → converge', run: mismatchedIdentity },
  { name: '19③ · fresh, crash after the intent', run: freshCrash('after-intent') },
  { name: '19③ · fresh, crash before the commit', run: freshCrash('before-commit') },
  { name: '19④ · converge, crash after the intent', run: convergeCrash('after-intent') },
  { name: '19④ · converge, crash after the transaction', run: convergeCrash('after-converge') },
  { name: '19④ · converge, crash before the commit', run: convergeCrash('before-commit') },
  { name: '19②/8 · the launch after a converge is normal', run: convergedIsStable },
];

export async function runD16Scenarios(): Promise<ScenarioRow[]> {
  const rows: ScenarioRow[] = [];
  for (const { name, run } of SCENARIOS) {
    try {
      rows.push({ name, ok: true, detail: await run() });
    } catch (err) {
      rows.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  // Leave the device on a clean, booted install rather than on whatever the
  // last scenario built.
  await resetInstall();
  return rows;
}
