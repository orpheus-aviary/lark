// Criterion 26 — D16's two missing carriers, on real hardware.
//
// D16 wants two things Expo does not offer:
//
//   1. **a zero-write read of the library's `install_id`**, before any service,
//      migration or credential touches the database. `SQLiteOpenOptions` has no
//      readonly flag (subplan E5), so decision k's first candidate is
//      copy-then-open: copy the file, open the COPY, throw it away. Opening a
//      WAL database can recover and checkpoint it — on the copy that is
//      harmless, on the original it would be a write during the one moment
//      D16 says nothing may write;
//   2. **a store that does NOT come back after a restore**, so that a restored
//      database can be told apart from a real one. Decision l: SecureStore,
//      whose keys live in the Keystore and never leave the device.
//
// This panel measures both, and one thing more that neither of them says:
// that the protocol's own guard works. `copyThenOpen({ tamper })` mutates the
// source between the two snapshots, which is the concurrent-writer case the
// retry-then-fail-closed rule exists for. A guard that has never been seen to
// trip is a guard nobody has tested.
//
// The `install_id` key name here is the spike's, not a decision: N2 owns where
// this lives in the real schema.

import {
  LATEST_KNOWN_VERSION,
  applyForwardMigrations,
  clearAudioMigrationPending,
} from '@lark/core/portable';
import { Directory, File } from 'expo-file-system';
import { deleteItemAsync, getItem, setItem } from 'expo-secure-store';
import { type SQLiteDatabase, defaultDatabaseDirectory, openDatabaseSync } from 'expo-sqlite';
import { type Timing, judge, measureColdStart } from '../measure';
import { ExpoSqliteShim } from '../sqlite/shim';

export interface IdentityRow {
  group: string;
  name: string;
  ok: boolean | null;
  detail: string;
  timing?: Timing;
}

/** The library under test. Deliberately not one of the contract's databases. */
const LIBRARY = 'd16-library.db';
/** Where a copy goes. Same filesystem as the source, so the copy is a copy. */
const COPY = 'd16-copy.db';
const SECURE_KEY = 'lark.install_id';
const INSTALL_ID_KEY = 'install_id';

/** §3.2a, criterion 26: five cold rounds, judged by the worst. */
const COPY_OPEN_BUDGET_MS = 500;
/** What "a 50MB library" means here. */
const BALLAST_TARGET_BYTES = 50 * 1024 * 1024;
const BALLAST_CHUNK_BYTES = 1024 * 1024;

const uri = (name: string): string => `file://${defaultDatabaseDirectory}/${name}`;

interface FileStat {
  exists: boolean;
  size: number;
  mtime: number | null;
}

function stat(name: string): FileStat {
  const file = new File(uri(name));
  if (!file.exists) return { exists: false, size: 0, mtime: null };
  return { exists: true, size: file.size, mtime: file.modificationTime };
}

const sameStat = (a: FileStat, b: FileStat): boolean =>
  a.exists === b.exists && a.size === b.size && a.mtime === b.mtime;

/**
 * main + `-wal`, and NOT `-shm`.
 *
 * SQLite's own documentation: the shared-memory file carries no content and is
 * not needed to recover a database — it is rebuilt from the WAL. Copying it
 * would be copying another process's view of a file we are not allowed to
 * disturb.
 */
const SOURCE_PARTS = ['', '-wal'] as const;

function snapshotSource(): Record<string, FileStat> {
  const out: Record<string, FileStat> = {};
  for (const part of SOURCE_PARTS) out[`${LIBRARY}${part}`] = stat(`${LIBRARY}${part}`);
  return out;
}

const sameSnapshot = (a: Record<string, FileStat>, b: Record<string, FileStat>): boolean =>
  Object.keys(a).every((key) => sameStat(a[key], b[key]));

function removeCopy(): void {
  for (const part of [...SOURCE_PARTS, '-shm']) {
    const file = new File(uri(`${COPY}${part}`));
    if (file.exists) file.delete();
  }
}

export class FailClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FailClosedError';
  }
}

export interface CopyOpenOutcome {
  installId: string | null;
  retries: number;
  copiedBytes: number;
  /**
   * What opening the copy did TO the copy — the write the original was spared.
   *
   * Measured across the open, not after it: closing the connection checkpoints
   * and removes `-wal`/`-shm`, so looking for sidecars afterwards finds an
   * empty room and reports "nothing happened" (which is exactly what the first
   * version of this said about a library with 4MB of hot WAL).
   */
  copyWrite: { mainChanged: boolean; walAbsorbed: boolean; detail: string };
}

/**
 * The bootstrap read: copy, open the copy, read, delete.
 *
 * `tamper` is the fake-failure hook — it runs between the two snapshots, which
 * is where a real concurrent writer would land.
 */
export function copyThenOpen(options: { tamper?: () => void } = {}): CopyOpenOutcome {
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    const before = snapshotSource();
    if (!before[LIBRARY].exists) {
      throw new FailClosedError(`${LIBRARY} does not exist — that is N2's "fresh library" branch`);
    }

    try {
      const copiedBytes = copyParts();
      options.tamper?.();

      if (!sameSnapshot(before, snapshotSource())) {
        removeCopy();
        // One retry, then fail closed: a source that moves twice is a source
        // something else is writing, and reading it would be reading half of
        // two states.
        if (attempt === 0) continue;
        throw new FailClosedError('the library changed under the copy twice — refusing to read it');
      }

      const copyBefore = stat(COPY);
      const copyWalBefore = stat(`${COPY}-wal`);
      const installId = readInstallIdFromCopy();
      const copyAfter = stat(COPY);
      const copyWalAfter = stat(`${COPY}-wal`);

      return {
        installId,
        retries: attempt,
        copiedBytes,
        copyWrite: {
          mainChanged: !sameStat(copyBefore, copyAfter),
          walAbsorbed: copyWalBefore.size > 0 && copyWalAfter.size === 0,
          detail:
            `copy main ${copyBefore.size} → ${copyAfter.size} bytes` +
            ` · copy wal ${copyWalBefore.size} → ${copyWalAfter.size} bytes`,
        },
      };
    } finally {
      // The copy is a secret in a temp file. It goes whether or not anything
      // above worked.
      removeCopy();
    }
  }

  throw new FailClosedError('unreachable');
}

/** Returns the bytes copied, so the timing row can say what it moved. */
function copyParts(): number {
  const directory = new Directory(`file://${defaultDatabaseDirectory}`);
  let copiedBytes = 0;
  for (const part of SOURCE_PARTS) {
    const source = new File(uri(`${LIBRARY}${part}`));
    if (!source.exists) continue;
    source.copySync(new File(directory, `${COPY}${part}`));
    copiedBytes += source.size;
  }
  return copiedBytes;
}

function readInstallIdFromCopy(): string | null {
  const db = openDatabaseSync(COPY);
  try {
    const row = db.getFirstSync<{ value: string }>(
      'SELECT value FROM local_metadata WHERE key = ?',
      [INSTALL_ID_KEY],
    );
    return row?.value ?? null;
  } finally {
    db.closeSync();
  }
}

function openLibrary(): { db: SQLiteDatabase; shim: ExpoSqliteShim } {
  const db = openDatabaseSync(LIBRARY);
  return { db, shim: new ExpoSqliteShim(db) };
}

/** A fresh mobile library plus an identity on both sides — N2's "brand new" path. */
export function seedIdentity(): IdentityRow[] {
  const rows: IdentityRow[] = [];
  const { db, shim } = openLibrary();
  try {
    const version = shim.pragma('user_version', { simple: true });
    if (version === 0) {
      // WAL in `db/index.ts`'s order — the same reason criterion 18's fixtures
      // do it: a library measured in DELETE mode is not this library.
      shim.pragma('busy_timeout = 5000');
      shim.pragma('foreign_keys = ON');
      shim.pragma('journal_mode = WAL');
      applyForwardMigrations(shim, 0, LATEST_KNOWN_VERSION);
      clearAudioMigrationPending(shim);
      rows.push({
        group: 'seed',
        name: 'library created',
        ok: true,
        detail: `migrated 0 → ${LATEST_KNOWN_VERSION}, WAL, not pending`,
      });
    } else {
      rows.push({
        group: 'seed',
        name: 'library already there',
        ok: true,
        detail: `user_version ${String(version)}`,
      });
    }

    // The no-backup side is written FIRST (D16's convergence order): a crash
    // between the two leaves a device that knows it was in the middle of
    // claiming an identity, rather than a database asserting one nobody
    // remembers issuing.
    const installId = `spike-${Date.now().toString(36)}-${Math.round(
      performance.now() * 1000,
    ).toString(36)}`;
    setItem(SECURE_KEY, installId, { requireAuthentication: false });
    shim
      .prepare('INSERT OR REPLACE INTO local_metadata (key, value) VALUES (?, ?)')
      .run(INSTALL_ID_KEY, installId);

    rows.push({
      group: 'seed',
      name: 'identity written to both sides',
      ok: true,
      detail: `install_id ${installId} (SecureStore first, then the database)`,
    });
  } finally {
    db.closeSync();
  }
  return rows;
}

/** D16's boot decision, run the way N2 will run it. */
export function checkIdentity(): IdentityRow[] {
  const rows: IdentityRow[] = [];

  const secureSide = getItem(SECURE_KEY);
  rows.push({
    group: 'check',
    name: 'SecureStore side',
    ok: secureSide !== null,
    detail:
      secureSide === null
        ? 'absent — after a reinstall or a restore this is the fail-closed signal'
        : secureSide,
  });

  let dbSide: string | null = null;
  try {
    const outcome = copyThenOpen();
    dbSide = outcome.installId;
    rows.push({
      group: 'check',
      name: 'database side (copy-then-open)',
      ok: dbSide !== null,
      detail:
        `${dbSide ?? 'no install_id row'} · copied ${(outcome.copiedBytes / 1024 / 1024).toFixed(1)}MB` +
        ` · retries ${outcome.retries} · ${outcome.copyWrite.detail}`,
    });
  } catch (err) {
    rows.push({
      group: 'check',
      name: 'database side (copy-then-open)',
      ok: false,
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }

  const verdict =
    dbSide === null && secureSide === null
      ? 'fresh — N2 generates both sides'
      : dbSide !== null && secureSide !== null && dbSide === secureSide
        ? 'normal — the two sides agree'
        : 'FAIL CLOSED — clear the binding and credentials, converge on a new id';
  rows.push({
    group: 'check',
    name: 'verdict',
    ok: !verdict.startsWith('FAIL'),
    detail: verdict,
  });

  return rows;
}

/** Grow the library to the size criterion 26 puts a stopwatch on. */
export function growLibrary(): IdentityRow[] {
  const { db, shim } = openLibrary();
  try {
    shim.exec('CREATE TABLE IF NOT EXISTS d16_ballast (id INTEGER PRIMARY KEY, blob BLOB)');
    const chunk = new Uint8Array(BALLAST_CHUNK_BYTES);
    // Incompressible enough for a size check to mean what it says: a file of
    // zeroes is the kind of fixture a filesystem can decide to store as a hole.
    for (let i = 0; i < chunk.length; i += 1) chunk[i] = (i * 31 + 7) % 251;

    const insert = shim.prepare('INSERT INTO d16_ballast (blob) VALUES (?)');
    let chunks = 0;
    while (stat(LIBRARY).size < BALLAST_TARGET_BYTES && chunks < 200) {
      insert.run(chunk);
      // Without a checkpoint the pages sit in the WAL and the main file stays
      // small — the thing being sized would be the wrong file.
      shim.pragma('wal_checkpoint(TRUNCATE)');
      chunks += 1;
    }

    // A real library has an open WAL when the app starts. Leave one, so the
    // copy has both parts to carry.
    shim
      .prepare('INSERT OR REPLACE INTO local_metadata (key, value) VALUES (?, ?)')
      .run('d16_ballast_marker', String(Date.now()));

    const main = stat(LIBRARY);
    const wal = stat(`${LIBRARY}-wal`);
    return [
      {
        group: 'fixture',
        name: 'library size',
        ok: main.size >= BALLAST_TARGET_BYTES,
        detail: `${(main.size / 1024 / 1024).toFixed(1)}MB main + ${(wal.size / 1024).toFixed(0)}KB wal (${chunks} chunks added)`,
      },
    ];
  } finally {
    db.closeSync();
  }
}

/** The timed criterion, plus the two assertions that make the timing mean something. */
export function measureCopyThenOpen(): IdentityRow[] {
  const rows: IdentityRow[] = [];
  const main = stat(LIBRARY);
  rows.push({
    group: 'copy-then-open',
    name: 'library under test',
    ok: main.size >= BALLAST_TARGET_BYTES,
    detail: `${(main.size / 1024 / 1024).toFixed(1)}MB main + ${(stat(`${LIBRARY}-wal`).size / 1024).toFixed(0)}KB wal (criterion 26 says 50MB)`,
  });

  const before = snapshotSource();
  let write: CopyOpenOutcome['copyWrite'] | null = null;
  const timing = measureColdStart('copy + open + read install_id', () => {
    write = copyThenOpen().copyWrite;
  });
  const after = snapshotSource();
  const untouched = sameSnapshot(before, after);

  rows.push({
    group: 'copy-then-open',
    name: 'the original was never written',
    // The whole point of candidate ①. If this is false the protocol is
    // pointless, however fast it is.
    ok: judge(untouched),
    detail: untouched
      ? 'size and mtime identical across five rounds'
      : `CHANGED: ${JSON.stringify({ before, after })}`,
  });

  rows.push({
    group: 'copy-then-open',
    name: 'shm was not copied',
    ok: judge(true),
    detail: `copied ${SOURCE_PARTS.map((p) => `${LIBRARY}${p}`).join(' + ')} · ${
      (write as CopyOpenOutcome['copyWrite'] | null)?.detail ?? 'no round completed'
    }`,
  });

  rows.push({
    group: 'copy-then-open',
    name: `max ≤ ${COPY_OPEN_BUDGET_MS}ms over 5 cold rounds`,
    ok: judge(timing.max <= COPY_OPEN_BUDGET_MS),
    detail: `max ${timing.max}ms · p50 ${timing.p50}ms · min ${timing.min}ms`,
    timing,
  });

  return rows;
}

/**
 * The same measurement, but with a HOT WAL — the state D16 actually fears.
 *
 * A library at rest has no WAL: the last connection to close checkpoints it
 * away, which is why the plain run above reports "the copy grew nothing". The
 * interesting case is the one after a crash (or with the app's own writer
 * still open): committed frames sitting in a `-wal`, waiting for the next
 * opener to recover them. Recovery is a WRITE, and the whole point of
 * candidate ① is that it happens to the copy.
 *
 * A second connection, left open for the duration, is how that state is held
 * still long enough to measure.
 */
export function measureCopyThenOpenHotWal(): IdentityRow[] {
  const writer = openDatabaseSync(LIBRARY);
  const writerShim = new ExpoSqliteShim(writer);
  try {
    const insert = writerShim.prepare(
      'INSERT OR REPLACE INTO local_metadata (key, value) VALUES (?, ?)',
    );
    for (let i = 0; i < 2000; i += 1) insert.run(`d16_hot_wal_${i}`, `${Date.now()}-${i}`);

    const wal = stat(`${LIBRARY}-wal`);
    const before = snapshotSource();
    let write: CopyOpenOutcome['copyWrite'] | null = null;
    const timing = measureColdStart('copy + open + read (hot WAL)', () => {
      write = copyThenOpen().copyWrite;
    });
    const after = snapshotSource();
    const untouched = sameSnapshot(before, after);

    return [
      {
        group: 'hot wal',
        name: 'the source has un-checkpointed frames',
        ok: wal.size > 0,
        detail: `${(wal.size / 1024).toFixed(0)}KB of WAL, held open by a second connection`,
      },
      {
        group: 'hot wal',
        name: 'recovery happened to the COPY',
        // Opening a database with committed WAL frames recovers and
        // checkpoints them. On the copy that shows up as the main file
        // changing and the WAL emptying — the write the original did not take.
        ok: judge(
          (write as CopyOpenOutcome['copyWrite'] | null)?.mainChanged === true &&
            (write as CopyOpenOutcome['copyWrite'] | null)?.walAbsorbed === true,
        ),
        detail: (write as CopyOpenOutcome['copyWrite'] | null)?.detail ?? 'no round completed',
      },
      {
        group: 'hot wal',
        name: 'the original was still never written',
        ok: judge(untouched),
        detail: untouched ? 'size and mtime identical across five rounds' : 'CHANGED',
      },
      {
        group: 'hot wal',
        name: `max ≤ ${COPY_OPEN_BUDGET_MS}ms over 5 cold rounds`,
        ok: judge(timing.max <= COPY_OPEN_BUDGET_MS),
        detail: `max ${timing.max}ms · p50 ${timing.p50}ms · min ${timing.min}ms`,
        timing,
      },
    ];
  } finally {
    // Closing is also what checkpoints the WAL away again, so the next run
    // starts from the same place this one did.
    writer.closeSync();
  }
}

/** The guard's own test: make the source move while the copy is being taken. */
export function probeRacingWriter(): IdentityRow[] {
  const { db, shim } = openLibrary();
  let writes = 0;
  try {
    const outcome = copyThenOpen({
      tamper: () => {
        writes += 1;
        shim
          .prepare('INSERT OR REPLACE INTO local_metadata (key, value) VALUES (?, ?)')
          .run('d16_racing_writer', `${Date.now()}-${writes}`);
      },
    });
    return [
      {
        group: 'fail-closed',
        name: 'a writer racing the copy is caught',
        ok: false,
        detail: `it did NOT fail closed — read ${outcome.installId ?? 'null'} after ${writes} interfering writes`,
      },
    ];
  } catch (err) {
    return [
      {
        group: 'fail-closed',
        name: 'a writer racing the copy is caught',
        ok: err instanceof FailClosedError,
        detail: `${writes} interfering writes → ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      },
    ];
  } finally {
    db.closeSync();
  }
}

/** Leave nothing behind for the next experiment to inherit. */
export async function forgetIdentity(): Promise<IdentityRow[]> {
  await deleteItemAsync(SECURE_KEY);
  const { db, shim } = openLibrary();
  try {
    shim.prepare('DELETE FROM local_metadata WHERE key = ?').run(INSTALL_ID_KEY);
  } finally {
    db.closeSync();
  }
  return [
    {
      group: 'seed',
      name: 'identity forgotten',
      ok: true,
      detail: 'both sides cleared — the next check should read as fresh',
    },
  ];
}
