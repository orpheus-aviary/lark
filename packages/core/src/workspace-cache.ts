// Opening the other workspaces so the cache can account for them (N7f).
//
// `portable/library/cache-across.ts` holds every rule; this holds the one
// thing it cannot: the host's way of opening a library it does not own. On
// this host that is a raw READ-ONLY connection — the same shape owl's
// `local-inspect.ts` uses, and for the same reason: going through
// `createDatabase` would run forward migrations, and a settings page has no
// business upgrading a library nobody asked it to open.
//
// 🔴 READ-ONLY IS NOT DECORATION HERE. Criterion 121 is that a cross-workspace
// drain deletes files and changes nothing else, and `readonly: true` is what
// makes that true of the database no matter what the code above does.
//
// ⚠️ It still creates `-wal` and `-shm` beside the library and does not remove
// them (measured in M6's backup). No row moves and no version changes; the
// files do appear.

import { existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { nodeFileSystem } from './node-fs.js';
import { workspacePaths, workspacePathsPort } from './paths.js';
import type { WorkspaceLibrary } from './portable/library/cache-across.js';
import * as schema from './portable/schema.js';
import { listWorkspaceIds } from './workspace-list.js';

export interface ForeignWorkspaces {
  workspaces: WorkspaceLibrary[];
  /** Close every connection this opened. Always call it. */
  close: () => void;
}

/**
 * Every workspace on this device except `current`, opened read-only.
 *
 * A library that cannot be opened is SKIPPED rather than fatal: the caller is
 * a status read or a background drain, and one unreadable library must not
 * stop a device from reporting — or reclaiming — the rest of its own disk.
 */
export function openForeignWorkspaces(current: string): ForeignWorkspaces {
  const opened: BetterSqlite3.Database[] = [];
  const workspaces: WorkspaceLibrary[] = [];

  for (const id of listWorkspaceIds()) {
    if (id === current) continue;
    const path = workspacePaths(id).db;
    if (!existsSync(path)) continue;
    try {
      const sqlite = new BetterSqlite3(path, { readonly: true });
      opened.push(sqlite);
      workspaces.push({
        id,
        files: { fs: nodeFileSystem(), paths: workspacePathsPort(id) },
        db: drizzle(sqlite, { schema }),
      });
    } catch {
      // Unreadable, locked, or not a database. Its bytes go uncounted and its
      // files unreclaimed, which is the conservative direction both ways.
    }
  }

  return {
    workspaces,
    close: () => {
      for (const sqlite of opened) sqlite.close();
    },
  };
}
