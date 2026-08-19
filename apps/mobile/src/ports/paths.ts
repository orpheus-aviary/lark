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
  LEGACY_AUDIO_FILE,
  LYRICS_FILE,
  type PathsPort,
  assertSongId,
} from '@lark/core/portable';
import { Directory, File, Paths } from 'expo-file-system';

/** `<Paths.document>/lark` — everything below is lark's. */
export function nestDirectory(): Directory {
  return new Directory(Paths.document, 'lark');
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
  return nestDirectory().uri;
}

/** The library file's name inside that directory. */
export const DATABASE_NAME = 'songs.db';

// ─── PathsPort (N2d) ────────────────────────────────────
//
// `join` lives here and nowhere else. Portable code names things — "this
// song's audio" — and never concatenates, because `songs/<id>/` is a real
// location built from an id that arrived over the wire: every path has to pass
// the UUID gate first (R10), and a module that could concatenate would
// eventually concatenate somewhere the gate is not.

/** Under the nest, beside `songs.db`. */
const SONGS_DIRECTORY = 'songs';

export function createPaths(): PathsPort {
  const songDirectory = (id: string): Directory => {
    // R10, before the id becomes a path. Not after.
    assertSongId(id);
    return new Directory(nestDirectory(), SONGS_DIRECTORY, id);
  };
  const songFile = (id: string, name: string): string => new File(songDirectory(id), name).uri;

  return {
    songDir: (id) => songDirectory(id).uri,
    songAudio: (id) => songFile(id, CANONICAL_AUDIO_FILE),
    songLegacyAudio: (id) => songFile(id, LEGACY_AUDIO_FILE),
    songLyrics: (id) => songFile(id, LYRICS_FILE),
  };
}
