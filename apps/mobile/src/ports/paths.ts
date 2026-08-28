// Where lark keeps its things on this phone (N2b; decision b).
//
//   <Paths.document>/lark/
//   ├── songs.db
//   └── songs/<song id>/{song.m4a, lyrics.lrc}
//
// Same shape as the desktop nest, one level down from the app's document
// directory, so "lark's data" is one directory rather than a database in
// expo-sqlite's default `SQLite/` folder and files somewhere else. D16's
// story depends on that: what gets excluded from backup, copied, or wiped is
// something you can point at.
//
// `Paths.document` is app-private. It cannot be written to with `adb push`,
// and `run-as` only works on debuggable builds — which is why acceptance
// fixtures arrive through the acceptance entry point's import channel rather
// than by pushing a file into place (decision o).
//
// The nest location answers the data layer; `PathsPort` at the bottom answers
// everything that names a song's files.

import {
  CANONICAL_AUDIO_FILE,
  DEFAULT_WORKSPACE_INDEX,
  DOWNLOAD_HISTORY_FILE,
  LEGACY_AUDIO_FILE,
  LIBRARIES_DIRECTORY,
  LYRICS_FILE,
  type PathsPort,
  type WorkspaceIndex,
  assertSongId,
  decideActiveWorkspace,
  parseWorkspaceIndex,
  workspaceSegments,
} from '@lark/core/portable';
import { Directory, File, Paths } from 'expo-file-system';

/** `<Paths.document>/lark` — everything below is lark's. */
export function nestDirectory(): Directory {
  return new Directory(Paths.document, 'lark');
}

/** The library file's name inside a workspace. */
export const DATABASE_NAME = 'songs.db';

/**
 * `<nest>/device.json` — what belongs to the PHONE rather than to a library
 * (N7a).
 *
 * Beside `songs.db` and not inside it, which is the whole point: one phone is
 * about to hold several libraries (N7), and a cache limit or a model endpoint
 * that changed with the active account would be a setting nobody touched. The
 * desktop has always had this file; it is called `lark_config.toml`.
 */
export function deviceSettingsFile(): File {
  return new File(nestDirectory(), 'device.json');
}

/**
 * `<nest>/workspaces.json` — which workspace this phone opens (N7b).
 *
 * JSON where the desktop keeps TOML, and the same file otherwise: what it
 * MEANS is `@lark/core/portable`'s `workspace-index.ts`, which both hosts
 * decode into. Device-level, beside `device.json`: it is the one fact that
 * cannot be worked out from the disk.
 */
export function workspacesFile(): File {
  return new File(nestDirectory(), 'workspaces.json');
}

/** `<nest>/libraries/` — the parent of every account workspace. */
export function librariesDirectory(): Directory {
  return new Directory(nestDirectory(), LIBRARIES_DIRECTORY);
}

/**
 * The root of ONE workspace: the nest itself for `local`, `libraries/<id>/`
 * for an account.
 *
 * `local` LIVES AT THE ROOT and that is the whole of §2.4: the library that
 * was already on this phone becomes the local workspace with nothing moved,
 * including one that had already been bound to an account. The id gate runs
 * before the join for the same reason `songDirectory`'s does — this one can
 * arrive from a file, and a path is not the place to find out it was wrong.
 */
export function workspaceDirectory(id: string): Directory {
  // The layout — and the id gate in front of it — is `portable/workspace.ts`'s,
  // the same segments the desktop joins onto `larkDir()`.
  return new Directory(nestDirectory(), ...workspaceSegments(id));
}

// ─── Which workspace THIS launch opens (N7d) ────────────
//
// The phone's half of the desktop's resolver, and the same two-question gate:
// `active` is an id this build understands, and its `songs.db` is on disk.
// Either one failing means `local` — which on a phone that has never switched
// is also the only answer there has ever been, so the ordinary device pays one
// `exists` check and nothing else.
//
// RESOLVED ONCE PER PROCESS, like everything else about a boot here. Switching
// is a restart (§2.5) and `bootOnce` already says why that is not a
// limitation: `downloadRuntimeOnce`, `syncContextOnce`, the player session and
// the engine's claim registry are all one-shot gates, and a path layer that
// changed its mind mid-process would have the engine writing into one library
// while the player read from another.
//
// LAZY rather than set by boot, deliberately. A path function that threw
// "before boot" would be a new class of crash on a screen that merely
// rendered early, and the file this reads is the same file boot would have
// read.

let cachedActiveWorkspace: string | null = null;

/** The index on disk, or the phone that has never switched. Never throws. */
export function readWorkspaceIndexFile(): WorkspaceIndex {
  const file = workspacesFile();
  if (!file.exists) return DEFAULT_WORKSPACE_INDEX;
  try {
    return parseWorkspaceIndex(JSON.parse(file.textSync()));
  } catch {
    // Empty, truncated, or unreadable: the same answer as never having
    // switched. `workspace-index.ts` says why that is the safe direction.
    return DEFAULT_WORKSPACE_INDEX;
  }
}

function judgeActiveWorkspace(): string {
  // The gate is `@lark/core/portable`'s — the same two questions the desktop
  // asks, with only "is the library there" spelled in this host's vocabulary.
  return decideActiveWorkspace(
    readWorkspaceIndexFile(),
    (id) => new File(workspaceDirectory(id), DATABASE_NAME).exists,
  ).id;
}

/** The workspace this launch opens. */
export function activeWorkspaceId(): string {
  if (cachedActiveWorkspace === null) cachedActiveWorkspace = judgeActiveWorkspace();
  return cachedActiveWorkspace;
}

/** Forget it. One real caller: a switch, which restarts the app anyway. */
export function invalidateActiveWorkspace(): void {
  cachedActiveWorkspace = null;
}

/**
 * The active workspace's root — where the library and its songs are.
 *
 * 🔴 EVERYTHING BELOW THIS LINE HANGS OFF HERE, not off `nestDirectory()`.
 * That is the whole isolation guarantee: two workspaces cannot see each
 * other's songs because there is one function that says where "here" is.
 */
export function libraryDirectory(): Directory {
  return workspaceDirectory(activeWorkspaceId());
}

/**
 * `<workspace>/downloads.json` — which downloads have already happened
 * (0.1.1 ⑦).
 *
 * BESIDE THE LIBRARY, not beside `device.json`: it names songs and playlists
 * that only mean anything inside one library, so an account's history has no
 * business showing up under another account's. That also makes deleting a
 * workspace take its history with it, without anybody writing that down.
 *
 * Not a table in `songs.db` for the reason `downloads/history.ts` gives: the
 * schema is shared with the desktop, and this is a fact about one phone.
 */
export function downloadHistoryFile(): File {
  return new File(libraryDirectory(), DOWNLOAD_HISTORY_FILE);
}

/**
 * The directory `openDatabaseSync` is given.
 *
 * A `file://` URI, not a POSIX path, and that is fine: expo-sqlite's Android
 * side runs the value through `toUri().path` before opening, and creates the
 * parent directory on the way (`SQLiteModule.kt`'s
 * `ensureDatabasePathExists`). Passing the URI keeps this in the same
 * vocabulary as expo-file-system, which is what every other path here speaks.
 */
export function databaseDirectoryUri(): string {
  return libraryDirectory().uri;
}

// ─── PathsPort (N2d) ────────────────────────────────────
//
// `join` lives here and nowhere else. Portable code names things — "this
// song's audio" — and never concatenates, because `songs/<id>/` is a real
// location built from an id that arrived over the wire: every path has to pass
// the UUID gate first (R10), and a module that could concatenate would
// eventually concatenate somewhere the gate is not.

/** Under the nest, beside `songs.db`. */
const SONGS_DIRECTORY = 'songs';

/**
 * Where a remote delete parks what it cannot replace: `recovered-songs/`.
 *
 * Same name and same place as the desktop nest. Sync can tell this device a
 * song is gone; audio it downloaded can be fetched again, but an imported file
 * only ever existed here, so it is moved rather than unlinked.
 */
const RECOVERED_DIRECTORY = 'recovered-songs';

/**
 * Where boot parks a song directory it cannot explain: `trash/`.
 *
 * Deliberately NOT `recovered-songs/`. The two look alike and are not: that one
 * belongs to sync — a remote delete moves what it cannot re-fetch into it, and
 * `/sync/status` counts what is in it as quarantined. A crash orphan has
 * nothing to do with sync, and landing it there would pollute that count the
 * day sync ships (N4 §1.6③).
 */
const TRASH_DIRECTORY = 'trash';

/**
 * `songs/` itself — the one place that enumerates song directories.
 *
 * Only the boot sweep needs this. Everything else names ONE song's directory,
 * which is what keeps the uuid gate in front of every path.
 */
export function songsRoot(): Directory {
  return new Directory(libraryDirectory(), SONGS_DIRECTORY);
}

/** `trash/` itself. */
export function trashRoot(): Directory {
  return new Directory(libraryDirectory(), TRASH_DIRECTORY);
}

/**
 * `trash/recovery-<stamp>/` — one directory per sweep that found something.
 *
 * The stamp is the caller's, so that everything one boot quarantines lands
 * together and a later boot cannot collide with it.
 */
export function trashRecoveryDirectory(stamp: string): Directory {
  return new Directory(trashRoot(), `recovery-${stamp}`);
}

/** `songs/<id>/` — R10 runs before the id becomes a path. Not after. */
export function songDirectory(id: string): Directory {
  assertSongId(id);
  return new Directory(libraryDirectory(), SONGS_DIRECTORY, id);
}

/** `recovered-songs/` itself. */
export function recoveredSongsRoot(): Directory {
  return new Directory(libraryDirectory(), RECOVERED_DIRECTORY);
}

/**
 * `recovered-songs/<target>/`.
 *
 * The target is a NAME the journal snapshotted, never a path — a nest that
 * moved must still resolve it (`sync/file-ops.ts`).
 */
export function recoveredSongsDirectory(target: string): Directory {
  return new Directory(recoveredSongsRoot(), target);
}

/**
 * A `PathsPort` for ONE workspace, whichever one is active (N7e).
 *
 * `createPaths()` answers for the workspace this process opened, which is what
 * the player, the engine and the library service all want. This one is for the
 * login that installs into a workspace this process is NOT serving: the
 * backfill reads lyrics off disk, and it has to read the target's.
 */
export function createPathsFor(workspaceId: string): PathsPort {
  const root = workspaceDirectory(workspaceId);
  const songDir = (id: string): Directory => {
    assertSongId(id);
    return new Directory(root, SONGS_DIRECTORY, id);
  };
  const songFile = (id: string, name: string): string => new File(songDir(id), name).uri;
  return {
    songDir: (id) => songDir(id).uri,
    songAudio: (id) => songFile(id, CANONICAL_AUDIO_FILE),
    songLegacyAudio: (id) => songFile(id, LEGACY_AUDIO_FILE),
    songLyrics: (id) => songFile(id, LYRICS_FILE),
  };
}

export function createPaths(): PathsPort {
  const songFile = (id: string, name: string): string => new File(songDirectory(id), name).uri;

  return {
    songDir: (id) => songDirectory(id).uri,
    songAudio: (id) => songFile(id, CANONICAL_AUDIO_FILE),
    songLegacyAudio: (id) => songFile(id, LEGACY_AUDIO_FILE),
    songLyrics: (id) => songFile(id, LYRICS_FILE),
  };
}
