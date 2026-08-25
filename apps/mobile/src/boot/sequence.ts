// §2.2, the frozen boot sequence. One file, in order, on purpose.
//
//   ① installPortableRuntime()          Random + whole-file sha256; without ①
//                                       every id mint throws, and (N6a) so does
//                                       reading a playlist file
//   ② zero-write reads                  library file · SecureStore · copy-then-open
//   ③ compatibility verdict (on a copy) §2.4; a refusal writes nothing and does
//                                       not touch SecureStore
//   ④ identity decision                 §2.2.1's table
//   ⑤ write the SecureStore intent      fresh and converge; normal skips ⑤⑧⑩
//   ⑥ open the real library (rw)        the first time this file is written to
//   ⑦ version dispatch / migrate        `prepareLibrary`
//   ⑧ converge, in one transaction      §2.2.2; does NOT touch sync_file_ops
//   ⑨ ensureDeviceUuid                  same position as the desktop's
//   ⑩ commit the intent                 SecureStore: committed set, intent cleared
//   ⑪ boot drain (file-op journal)      before anything looks at the song dirs
//  ⑪b sweep songs/ against the library  after the drain, before the engine
//   ⑫ hand back the library             services and UI are the caller's
//
// THREE ORDERINGS THAT MUST NOT MOVE, each with the failure it prevents:
//
//   ③ before any write — otherwise a library this client refuses gets written
//     to before being refused, and `journal_mode` is a FILE-level property.
//   ⑤ before ⑥ — otherwise a crash mid-claim leaves a library with no
//     identity, which is indistinguishable from a restored one, and the next
//     launch wipes it. That was v2's bug.
//   ⑪ before ⑪b before ⑫ — the journal's rows are file halves of decisions the
//     database already committed, and the sweep judges directories against the
//     database: run the other way round it would read a half-finished op as
//     crash residue. And the sweep has to be over before anything that could
//     write a song directory exists. Same ordering as the desktop's
//     (`daemon/src/boot.ts`: drain, recover, THEN the engine); N4 §1.6① is the
//     amendment that inserted ⑪b into this frozen list.
//
// This is the only thing entitled to open the real library. `db/open.ts` does
// ⑥⑦ and is called from here; nothing else should call it against
// `songs.db`.

import {
  type DrainResult,
  type FileContext,
  FileEffectRuntime,
  type PortableDb,
  type StructuredLogger,
  ensureDeviceUuid,
  pendingFileOpSongIds,
  uuid,
} from '@lark/core/portable';
import type { SQLiteDatabase } from 'expo-sqlite';
import { openLibrary } from '../db/open';
import { type ConvergeResult, claimFreshLibrary, convergeLibrary } from '../identity/converge';
import { libraryExists, probeLibrary } from '../identity/snapshot';
import { type IdentityDecision, type IdentityPurpose, decideIdentity } from '../identity/state';
import { commitIdentity, readCommitted, readIntent, writeIntent } from '../identity/store';
import { createSecureCredentialStore } from '../ports/credentials';
import { createFileSystem } from '../ports/fs';
import { createPaths } from '../ports/paths';
import { createSongFiles } from '../ports/song-files';
import { installPortableRuntime } from './runtime';
import { type SweepReport, sweepSongsStore } from './sweep';

export interface BootResult {
  handle: SQLiteDatabase;
  db: PortableDb;
  /** The identity this install now holds. */
  installId: string;
  /** What the decision table said, verbatim — the panel and the log print it. */
  decision: IdentityDecision;
  /** Present when step ⑧ ran. */
  converged: ConvergeResult | null;
  deviceUuid: string;
  /**
   * The journal runtime step ⑪ drained, handed on rather than rebuilt.
   *
   * ⚠️ THIS ONE IS BOOT'S, AND ONLY BOOT'S — the note that used to stand here
   * said the caller's services must use it, and N4 made that false. Boot
   * drains before a download engine exists, so its registry is correct for
   * boot and wrong for everything outliving it: `LibraryService` (N4b) and the
   * sync coordinator (N5c) both take `downloadRuntimeOnce(boot).fileOps`
   * instead, because a delete unlinking a song's audio and a download
   * replacing it can only take turns through ONE claim registry. Which is the
   * shape the desktop has always had (`daemon/src/boot.ts`).
   */
  fileOps: FileEffectRuntime;
  /** What step ⑪ found waiting. */
  drained: DrainResult;
  /** What step ⑪b found on disk that the library could not account for. */
  swept: SweepReport;
  /**
   * Files, as one capability, built once here and handed on.
   *
   * The port says the pair travels together as a field of the context a caller
   * already receives, precisely so that it is not a module global two places
   * construct separately (`ports/fs.ts`). Step ⑪ needs it; so does the library
   * service the caller assembles next.
   */
  files: FileContext;
}

export interface BootOptions {
  logger?: StructuredLogger;
  /**
   * Acceptance builds only: called at the named point so criterion 19 can kill
   * the process there rather than guess at timing with `am force-stop`.
   */
  crashPoint?: (point: BootCrashPoint) => void;
}

export type BootCrashPoint =
  | 'after-intent'
  | 'after-open'
  | 'after-converge'
  | 'before-commit'
  | 'after-commit';

/** What ⑤ has to write, and what ⑩ will commit. */
function plannedIdentity(decision: IdentityDecision): {
  purpose: IdentityPurpose;
  installId: string;
} | null {
  switch (decision.action) {
    case 'normal':
      return null;
    case 'fresh':
      return { purpose: 'fresh', installId: uuid() };
    case 'converge':
      return { purpose: 'converge', installId: uuid() };
    case 'resume':
      // The SAME id, which is what makes redoing it idempotent rather than
      // merely repeatable.
      return { purpose: decision.purpose, installId: decision.installId };
  }
}

/**
 * The boot the PRODUCT does: once per process, whatever the Activity does.
 *
 * MEASURED (N2f, frozen device): press BACK and relaunch — the Activity is
 * destroyed and rebuilt while the process lives — and a second
 * `runBootSequence` fails with `NativeDatabase.prepareSync … NullPointerException`.
 * expo-sqlite 57.0.1's `OnDestroy` is meant to close its cached databases and
 * does not: `removeAllCachedDatabases` returns the very list it just cleared,
 * so `forEach` walks nothing. What is left behind is JS handles whose native
 * side is gone, and the next open trips over them.
 *
 * Booting once per process is the right shape regardless. The sequence is a
 * PROCESS-level act — the identity gate, the migration, the journal drain —
 * and running it again because a screen remounted would re-probe and re-drain
 * a library this process already owns.
 *
 * Acceptance keeps calling `runBootSequence` directly: its whole job is to
 * boot repeatedly from states it chose, and a memo would hand it the previous
 * scenario's library.
 */
let booted: Promise<BootResult> | null = null;

export function bootOnce(options: BootOptions = {}): Promise<BootResult> {
  if (booted === null) {
    booted = runBootSequence(options).catch((err: unknown) => {
      // A refusal is not a cached answer: the next launch of this process
      // should get to try again rather than inherit a verdict.
      booted = null;
      throw err;
    });
  }
  return booted;
}

export async function runBootSequence(options: BootOptions = {}): Promise<BootResult> {
  const { logger, crashPoint } = options;

  // ① Before anything can mint an id.
  installPortableRuntime();

  // ② Three zero-write reads. The probe is skipped when there is no library —
  // there is nothing to copy, and the decision does not need one.
  const exists = libraryExists();
  const probe = exists ? probeLibrary() : null; // ③ throws here on an incompatible library
  const decision = decideIdentity({
    libraryExists: exists,
    committed: readCommitted(),
    intent: readIntent(),
    dbInstallId: probe?.installId ?? null,
  });
  logger?.info({ action: decision.action, reason: decision.reason }, 'D16 boot decision');

  // ④ → ⑤
  const planned = plannedIdentity(decision);
  if (planned !== null) {
    writeIntent({ id: planned.installId, purpose: planned.purpose });
    crashPoint?.('after-intent');
  }

  // ⑥ ⑦
  const { handle, db } = openLibrary();
  crashPoint?.('after-open');

  try {
    let converged: ConvergeResult | null = null;

    if (planned !== null) {
      if (planned.purpose === 'converge') {
        // ⑧
        converged = convergeLibrary({
          db,
          installId: planned.installId,
          credentials: createSecureCredentialStore(),
        });
        logger?.warn({ ...converged, installId: planned.installId }, 'converged a foreign library');
      } else {
        claimFreshLibrary(db, planned.installId);
      }
      crashPoint?.('after-converge');
    }

    // ⑨ — same position as the desktop's `db/index.ts`. On the converge path
    // this is what replaces the identity step ⑧ deleted.
    const deviceUuid = ensureDeviceUuid(db.sqlite, logger);

    // ⑩
    crashPoint?.('before-commit');
    const installId = planned?.installId ?? (readCommitted() as string);
    if (planned !== null) await commitIdentity(installId);
    crashPoint?.('after-commit');

    // ⑪ boot drain. Every row in the journal is a consequence the database
    // already committed whose file half has not happened yet — a song a peer
    // deleted, lyrics that arrived, a directory to move aside. Anything that
    // judges a song directory against the library would meet a half-finished
    // effect and read it as residue (`portable/sync/file-ops.ts`), so this
    // runs before the caller gets the library, not after.
    const files: FileContext = { fs: createFileSystem(), paths: createPaths() };
    const fileOps = new FileEffectRuntime({
      sqlite: db.sqlite,
      files,
      songFiles: createSongFiles(),
      logger,
    });
    const drained = await fileOps.drain();
    if (drained.executed + drained.failed + drained.skipped > 0) {
      logger?.info({ ...drained }, 'sync file journal drained');
    }

    // ⑪b the sweep, skipping every directory the journal still owns. What the
    // drain just left behind is an op that failed or is backing off, and such a
    // directory looks exactly like a crash orphan — files, no row (§1.6②).
    const swept = await sweepSongsStore(db, {
      skipSongIds: pendingFileOpSongIds(db.sqlite),
      logger,
    });

    // ⑫
    return {
      handle,
      db,
      installId,
      decision,
      converged,
      deviceUuid,
      fileOps,
      drained,
      swept,
      files,
    };
  } catch (err) {
    handle.closeSync();
    throw err;
  }
}
