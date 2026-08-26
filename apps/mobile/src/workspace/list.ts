// Which libraries this phone holds (N7e-4).
//
// 🔑 THE DISK IS THE REGISTER, same as the desktop: a directory under
// `libraries/` whose name is a workspace id and which holds a `songs.db` IS a
// workspace. The index only adds a label and says which one the next launch
// will open, so a damaged one costs a name rather than a library.
//
// ⚠️ NO SONG COUNTS, unlike the desktop's list, and that is a decision rather
// than an omission. Counting means opening the library, and this host has no
// read-only open — `SQLiteOpenOptions` has no such flag, and opening a WAL
// database can recover and checkpoint it (`identity/snapshot.ts`). The desktop
// can ask cheaply because better-sqlite3 has `readonly: true`. Here the honest
// options were "copy the whole library to count its rows" or "do not count",
// and a settings list is not worth the first.

import { WORKSPACE_LOCAL, isAccountWorkspaceId } from '@lark/core/portable';
import { Directory, File } from 'expo-file-system';
import {
  DATABASE_NAME,
  activeWorkspaceId,
  librariesDirectory,
  readWorkspaceIndexFile,
} from '../ports/paths';

export interface WorkspaceRow {
  id: string;
  /** Usually the account. `''` until a login names it. */
  label: string;
  server_url: string;
  /**
   * The one the NEXT launch will open.
   *
   * Not "the one on screen": those differ from the moment somebody switches
   * until they reopen the app, which is the window a list has to be honest
   * about.
   */
  active: boolean;
  /** The one this launch actually opened — what everything on screen is about. */
  serving: boolean;
}

/** Every id with a library on disk, plus `local`, which always counts. */
export function listWorkspaceIds(): string[] {
  const ids = [WORKSPACE_LOCAL];
  const root = librariesDirectory();
  if (!root.exists) return ids;
  for (const entry of root.list()) {
    if (!(entry instanceof Directory)) continue;
    // A half-built one is `.incoming-<id>`, which is not an id — so a listing
    // that only accepts ids cannot mistake one for a workspace.
    if (!isAccountWorkspaceId(entry.name)) continue;
    if (new File(entry, DATABASE_NAME).exists) ids.push(entry.name);
  }
  return ids;
}

export function listWorkspaces(): WorkspaceRow[] {
  const index = readWorkspaceIndexFile();
  const serving = activeWorkspaceId();
  // What the next launch opens: the index's answer, put through the same gate
  // a launch would use.
  const next = listWorkspaceIds().includes(index.active) ? index.active : WORKSPACE_LOCAL;

  return listWorkspaceIds().map((id) => {
    const entry = index.entries[id];
    return {
      id,
      label: entry?.label ?? '',
      server_url: entry?.server_url ?? '',
      active: id === next,
      serving: id === serving,
    };
  });
}

/** What a person recognises: the account, or the words for the one with none. */
export function workspaceTitle(row: { id: string; label: string }): string {
  if (row.id === WORKSPACE_LOCAL) return '本机曲库';
  return row.label === '' ? `账号曲库 ${row.id.slice(0, 8)}` : row.label;
}
