// Opening the other workspaces so the cache can account for them (N7f).
//
// The phone's half of `core/workspace-cache.ts`, and the one place it is
// weaker: this host has NO read-only open. `SQLiteOpenOptions` carries no such
// flag, so a library is opened the only way expo-sqlite opens one.
//
// What still holds, and it is the part criterion 121 is about: nothing here
// writes a row. `runEviction` only ever SELECTs — `has_file` is a disk probe,
// not a column, so there is nothing to update after a delete — and
// `prepareLibrary` is deliberately NOT called, so no migration runs either.
// What an open can do to the file is SQLite's own housekeeping: recover a
// write-ahead log that a kill left behind, and leave `-wal`/`-shm` beside it.
// That is a repair, not a change of contents, and the desktop's read-only open
// leaves the sidecars too.
//
// A library that will not open is SKIPPED rather than fatal: the caller is a
// settings figure or a background drain, and one unreadable library must not
// stop the phone reporting — or reclaiming — the rest of its own storage.

import type { WorkspaceLibrary } from '@lark/core/portable';
import { openDatabaseSync } from 'expo-sqlite';
import { portableDbOf } from '../db/portable-db';
import { createFileSystem } from '../ports/fs';
import { DATABASE_NAME, createPathsFor, workspaceDirectory } from '../ports/paths';
import { listWorkspaceIds } from './list';

export interface ForeignWorkspaces {
  workspaces: WorkspaceLibrary[];
  /** Close every handle this opened. Always call it. */
  close: () => void;
}

export function openForeignWorkspaces(current: string): ForeignWorkspaces {
  const opened: { closeSync: () => void }[] = [];
  const workspaces: WorkspaceLibrary[] = [];

  for (const id of listWorkspaceIds()) {
    if (id === current) continue;
    try {
      const handle = openDatabaseSync(DATABASE_NAME, {}, workspaceDirectory(id).uri);
      opened.push(handle);
      workspaces.push({
        id,
        files: { fs: createFileSystem(), paths: createPathsFor(id) },
        db: portableDbOf(handle).drizzle,
      });
    } catch {
      // Unreadable, or not a database this build understands.
    }
  }

  return {
    workspaces,
    close: () => {
      for (const handle of opened) handle.closeSync();
    },
  };
}
