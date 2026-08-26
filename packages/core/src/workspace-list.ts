// What workspaces this device holds, and what is in them (N7e).
//
// 🔑 THE DISK IS THE REGISTER, not the index file (`workspace-index.ts` says
// why). A directory under `libraries/` whose name is a workspace id and which
// holds a `songs.db` IS a workspace; the index only adds a label and says
// which one is active. So this lists the disk and decorates it, which is what
// makes a damaged index cost a name rather than a library.
//
// EVERY OTHER WORKSPACE IS OPENED READ-ONLY, on a raw connection — the same
// shape as owl's `local-inspect.ts`, and for the same reason: going through
// `createDatabase` would run forward migrations, and a settings screen has no
// business upgrading a library nobody asked it to open.
//
// ⚠️ ONE HONEST SIDE EFFECT: a read-only connection to a WAL database creates
// `-wal` and `-shm` beside it and does not remove them on close. That is not a
// change to the data — no row moves, no version changes — but the files do
// appear. Everything downstream is written knowing that (the migration
// checkpoints rather than moving them; the backup drops them).

import { existsSync, readdirSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { librariesDir, workspacePaths } from './paths.js';
import { hasSyncTraces } from './portable/sync/traces.js';
import { type WorkspaceIndex, decideActiveWorkspace } from './portable/workspace-index.js';
import { WORKSPACE_LOCAL, isAccountWorkspaceId } from './portable/workspace.js';

export interface WorkspaceInspection {
  /** Songs the library holds. 0 for a workspace with no library yet. */
  songs: number;
  /** Playlists, for the same reason: it is what a person recognises. */
  playlists: number;
  /**
   * Leftover state from a PRIOR account — a sync cursor, a change that was
   * pushed, or a stored skybridge id (owl's `hasSyncTraces`, B8).
   *
   * Only reachable on a library that was bound before N7 and kept in place as
   * `local`. It drives a warning, because claiming such a library into a NEW
   * account would republish what the old one already had.
   */
  hasSyncTraces: boolean;
}

const EMPTY: WorkspaceInspection = { songs: 0, playlists: 0, hasSyncTraces: false };

function count(sqlite: BetterSqlite3.Database, sql: string): number {
  try {
    return (sqlite.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
  } catch {
    return 0; // a table this build knows and that library does not
  }
}

/** Look inside one workspace without opening it for writing. */
export function inspectWorkspace(id: string): WorkspaceInspection {
  const path = workspacePaths(id).db;
  if (!existsSync(path)) return EMPTY;

  const sqlite = new BetterSqlite3(path, { readonly: true });
  try {
    return {
      songs: count(sqlite, 'SELECT count(*) AS n FROM songs'),
      playlists: count(sqlite, 'SELECT count(*) AS n FROM playlists'),
      // The judgement is portable — the phone asks the same question of the
      // library it already has open, because its host has no read-only open.
      hasSyncTraces: hasSyncTraces(sqlite),
    };
  } finally {
    sqlite.close();
  }
}

export interface WorkspaceSummary {
  id: string;
  /** The index's decoration. `''` when nothing has named it. */
  label: string;
  server_url: string;
  /** The one this device opens — which is not always the one it is serving. */
  active: boolean;
  songs: number;
  playlists: number;
}

/** Every id with a library on disk, plus `local`, which always counts. */
export function listWorkspaceIds(): string[] {
  const ids = [WORKSPACE_LOCAL];
  let entries: string[];
  try {
    entries = readdirSync(librariesDir());
  } catch {
    return ids; // no `libraries/` yet, which is every device that never logged in
  }
  for (const entry of entries.sort()) {
    // A half-built workspace is `.incoming-<id>`, which is not an id — so a
    // listing that only accepts ids cannot mistake one for a workspace.
    if (!isAccountWorkspaceId(entry)) continue;
    if (existsSync(workspacePaths(entry).db)) ids.push(entry);
  }
  return ids;
}

/**
 * The switcher's list.
 *
 * `local` is always in it, with or without a library: it is where a device
 * that has never logged in lives, and where a device that logs out of
 * everything can go back to.
 *
 * 🔴 `active` IS WHAT THE NEXT LAUNCH WILL OPEN, read from the index and put
 * through the same gate a launch would — NOT what this process opened. The two
 * differ for exactly as long as it takes somebody to restart after a switch,
 * which is precisely the window a switcher has to be honest about.
 */
export function listWorkspaces(index: WorkspaceIndex): WorkspaceSummary[] {
  const active = decideActiveWorkspace(index, (id) => existsSync(workspacePaths(id).db)).id;
  return listWorkspaceIds().map((id) => {
    const entry = index.entries[id];
    const inspection = inspectWorkspace(id);
    return {
      id,
      label: entry?.label ?? '',
      server_url: entry?.server_url ?? '',
      active: id === active,
      songs: inspection.songs,
      playlists: inspection.playlists,
    };
  });
}
