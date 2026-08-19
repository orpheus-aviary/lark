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
// This file grows into the full `PathsPort` in N2d. Today it answers the one
// question the data layer asks.

import { Directory, Paths } from 'expo-file-system';

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
