// The fixture channel for a REAL desktop library (decision o④, criterion 14).
//
// `Paths.document` is app-private: `adb push` cannot reach it and `run-as` only
// works on debuggable builds, which the acceptance artifact is not. What adb
// CAN write is the app's own external files directory, under
// `/sdcard/Android/data/<package>/files/`.
//
// But only if THE APP made it. Pushing into a path that does not exist yet
// creates the intermediate directories as `shell`, and this app is then denied
// at `Android/data` — measured, and `fixtureDirectory` below carries the probe
// output. So the order is: the app calls `getExternalFilesDir(null)` (which
// creates it), then adb pushes into it, then this reads it. `just
// mobile-push-fixture` refuses to run out of order rather than producing a
// directory nobody can open.
//
// N2c narrowed this channel deliberately: D16's own criteria need a library
// this install has no identity for, and the faithful way to make one is to
// build a real library and take the identity away — no file needs pushing.
// This exists for the one thing that cannot be synthesised: a library the
// DESKTOP wrote, with the user's real schema, rows and audio in it.
//
// IT ARRIVES AS A `normal` LIBRARY, NOT A CONVERGE (decision o, "本次定死").
// Criterion 14 is about tabs, sorting and reordering; converge would clear
// binding and sync state and rebuild `device_uuid` on the way in, and a
// failure there would be indistinguishable from a failure in the library UI.
// The converge path has criteria 17 and 18 to itself. So this channel does the
// two identity edits ITSELF, explicitly:
//
//   `install_id` becomes this install's committed value — the library is now
//     this phone's, which is exactly the claim being made by importing it.
//   `device_uuid` is DELETED so step ⑨ mints a fresh one. Keeping the
//     desktop's would leave two installs sharing one local identity, and the
//     tombstone and echo rules of sync are built on that value being unique
//     (decision j, the same reason converge rebuilds it).

import type { PortableDb } from '@lark/core/portable';
import { Directory, File } from 'expo-file-system';
import { openDatabaseSync } from 'expo-sqlite';
import LarkFs from '../../modules/lark-fs';
import { runBootSequence } from '../boot/sequence';
import { portableDbOf } from '../db/portable-db';
import { INSTALL_ID_KEY } from '../identity/snapshot';
import { readCommitted } from '../identity/store';
import { DATABASE_NAME, libraryDirectory, recoveredSongsRoot } from '../ports/paths';
import type { ScenarioRow } from './d16';

/** Where the driver pushes it. Must match `just mobile-push-fixture`. */
const FIXTURE_DIRECTORY = 'lark-fixture';

/**
 * `<external files>/lark-fixture/`, from Android rather than from string
 * surgery.
 *
 * MEASURED (N2f): building the path in JS is easy and wrong. It produces the
 * right string — `/storage/emulated/0/Android/data/<package>/files/…` — and a
 * directory this app cannot read, because `adb push` created the intermediate
 * directories as `shell` and the app is then denied at `Android/data`. The
 * visibility probe said `0✓/Android✓/data✗/<package>✗/files✗`.
 *
 * And asking Android only for the path is not enough either: expo decides
 * write permission by `File(path).canWrite()` on the path itself, so creating
 * the child from JS is refused for a directory this app is entitled to make.
 * `LarkFs.externalDirectory` therefore does both halves natively, which is
 * also why the push recipe refuses to run before this has.
 */
export function fixtureDirectory(): Directory {
  return new Directory(LarkFs.externalDirectory(FIXTURE_DIRECTORY));
}

export interface FixtureImport {
  songs: number;
  playlists: number;
  songDirectories: number;
  installId: string;
  /**
   * The `device_uuid` the DESKTOP wrote, kept so the criterion can assert the
   * phone did not inherit it.
   *
   * Without this the check has nothing to compare against: "the stored uuid is
   * the one boot returned" is true whether step ⑨ minted a new one or found
   * the desktop's and left it alone, which is exactly the value decision j
   * says two installs must never share.
   */
  desktopDeviceUuid: string | null;
}

/**
 * Copy the pushed library into the nest and make it this install's.
 *
 * Everything already in the nest goes first: importing over a library would
 * leave whichever song directories the old one had, and a `songs/<id>/` with
 * no row is exactly the residue boot recovery exists to clean up — a mess this
 * channel would be manufacturing rather than testing.
 */
export async function importPushedFixture(): Promise<FixtureImport> {
  const source = validatedSource();
  const committed = await thisInstallsIdentity();

  const nest = clearedNest();
  await new File(source, DATABASE_NAME).copy(new File(nest, DATABASE_NAME));
  const songs = new Directory(source, 'songs');
  if (songs.exists) await songs.copy(new Directory(nest, 'songs'));

  return claimImported(committed);
}

function validatedSource(): Directory {
  // Creating it is what `fixtureDirectory` DOES — see there for why that is
  // native. So an empty one means "first run on this phone", not a mistake.
  const source = fixtureDirectory();
  if (!new File(source, DATABASE_NAME).exists) {
    throw new Error(`${source.uri} holds no ${DATABASE_NAME} — push into it and run this again`);
  }
  // A `-wal` beside it means the backup was not checkpointed, and copying only
  // the main file would silently drop whatever is in the log. `just
  // backup-nest` produces a single checkpointed file; anything else is a
  // fixture nobody can vouch for.
  for (const sidecar of ['-wal', '-shm']) {
    if (new File(source, `${DATABASE_NAME}${sidecar}`).exists) {
      throw new Error(`the fixture carries a ${sidecar} — check it out with backup-nest, not cp`);
    }
  }
  return source;
}

/**
 * This install needs an identity of its own before it can claim anything. A
 * phone that has never booted has none, so make one the ordinary way.
 */
async function thisInstallsIdentity(): Promise<string> {
  const already = await readCommitted();
  if (already !== null) return already;
  (await runBootSequence()).handle.closeSync();
  const committed = await readCommitted();
  if (committed === null) throw new Error('a fresh boot left no committed install_id');
  return committed;
}

function clearedNest(): Directory {
  const nest = libraryDirectory();
  if (!nest.exists) nest.create({ intermediates: true });
  for (const stale of [
    new File(nest, DATABASE_NAME),
    new File(nest, `${DATABASE_NAME}-wal`),
    new File(nest, `${DATABASE_NAME}-shm`),
  ]) {
    if (stale.exists) stale.delete();
  }
  for (const stale of [new Directory(nest, 'songs'), recoveredSongsRoot()]) {
    if (stale.exists) stale.delete();
  }
  return nest;
}

/** Open the copy directly — not through the boot sequence — and make it ours. */
function claimImported(installId: string): FixtureImport {
  const handle = openDatabaseSync(DATABASE_NAME, {}, libraryDirectory().uri);
  try {
    const db = portableDbOf(handle);
    const desktopDeviceUuid =
      (
        db.sqlite.prepare("SELECT value FROM local_metadata WHERE key='device_uuid'").get() as
          | { value: string }
          | undefined
      )?.value ?? null;
    db.sqlite.transaction(() => {
      db.sqlite
        .prepare('INSERT OR REPLACE INTO local_metadata (key, value) VALUES (?, ?)')
        .run(INSTALL_ID_KEY, installId);
      db.sqlite.prepare("DELETE FROM local_metadata WHERE key = 'device_uuid'").run();
    })();
    return {
      songs: rowCount(db, 'songs'),
      playlists: rowCount(db, 'playlists'),
      songDirectories: directoriesIn(new Directory(libraryDirectory(), 'songs')),
      installId,
      desktopDeviceUuid,
    };
  } finally {
    handle.closeSync();
  }
}

const rowCount = (db: PortableDb, table: string): number =>
  (db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

const directoriesIn = (directory: Directory): number =>
  directory.exists ? directory.list().filter((entry) => entry instanceof Directory).length : 0;

/**
 * The channel, as a panel row: import, then boot and check the verdict.
 *
 * The verdict is the assertion. A library that arrived without its two
 * identity edits would be judged `converge` and cleaned on the way in, and
 * every criterion built on this fixture would then be measuring D16.
 */
export async function runFixtureImportScenarios(): Promise<ScenarioRow[]> {
  const rows: ScenarioRow[] = [];
  try {
    const imported = await importPushedFixture();
    rows.push({
      name: '14 · a real desktop library is imported',
      ok: imported.songs > 0 && imported.songDirectories > 0,
      detail: `${imported.songs} songs · ${imported.playlists} playlists · ${imported.songDirectories} song directories`,
    });

    const boot = await runBootSequence();
    try {
      const stored = boot.db.sqlite
        .prepare("SELECT value FROM local_metadata WHERE key='device_uuid'")
        .get() as { value: string } | undefined;
      rows.push({
        name: '14 · and this install opens it as its own',
        ok:
          boot.decision.action === 'normal' &&
          boot.installId === imported.installId &&
          stored?.value === boot.deviceUuid &&
          boot.deviceUuid !== imported.desktopDeviceUuid,
        detail: `decision '${boot.decision.action}' · install ${boot.installId.slice(0, 8)}… · device_uuid ${imported.desktopDeviceUuid?.slice(0, 8) ?? '(none)'}… → ${boot.deviceUuid.slice(0, 8)}…`,
      });
    } finally {
      boot.handle.closeSync();
    }
  } catch (err) {
    rows.push({
      name: '14 · a real desktop library is imported',
      ok: false,
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
  return rows;
}
