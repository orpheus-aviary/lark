// Writing `<nest>/workspaces.json` (N7e-4).
//
// Reading it is in `ports/paths.ts`, because the path layer needs it before
// anything else exists. Writing needs the atomic replace — which needs
// `modules/lark-fs` — so it lives here, next to the two operations that do it.
//
// 🔴 THE ORDER IS FROZEN AND IT IS THE SAME ONE THE DESKTOP HAS: the library
// has to be on disk BEFORE the index may name it. `decideActiveWorkspace`
// gates on exactly that, so an index written first would produce a switch that
// silently falls back to `local` — a switch that looks like it worked and then
// shows an empty library.
//
// AND NOTHING ELSE CHANGES. The cache in `ports/paths.ts` holds which library
// THIS process opened, and every path hangs off it; busting it here would
// leave the app playing one library while writing songs and credentials into
// another. That the app carries on with the old one until it is reopened is
// criterion 115's "not half-switched", and it is a property of doing exactly
// one thing.

import {
  type FileSystemPort,
  WORKSPACE_LOCAL,
  type WorkspaceIndex,
  isWorkspaceId,
  serializeWorkspaceIndex,
  withActiveWorkspace,
  withWorkspaceEntry,
} from '@lark/core/portable';
import { File } from 'expo-file-system';
import {
  DATABASE_NAME,
  readWorkspaceIndexFile,
  workspaceDirectory,
  workspacesFile,
} from '../ports/paths';

/** Replace the index, whole. Never a merge — the caller holds the truth. */
export async function writeWorkspaceIndexFile(
  fs: FileSystemPort,
  index: WorkspaceIndex,
): Promise<void> {
  await fs.writeTextAtomic(
    workspacesFile().uri,
    JSON.stringify(serializeWorkspaceIndex(index), null, 2),
  );
}

export interface SwitchOutcome {
  id: string;
  previous: string;
  changed: boolean;
}

/** Point this phone at `id`. Takes effect the next time the app is opened. */
export async function switchWorkspace(fs: FileSystemPort, id: string): Promise<SwitchOutcome> {
  if (!isWorkspaceId(id)) throw new Error(`not a workspace id: ${id}`);
  if (id !== WORKSPACE_LOCAL && !new File(workspaceDirectory(id), DATABASE_NAME).exists) {
    throw new Error('这个曲库还没有准备好——先登录一次这个账号');
  }

  const index = readWorkspaceIndexFile();
  const previous = index.active;
  if (previous === id) return { id, previous, changed: false };

  await writeWorkspaceIndexFile(fs, withActiveWorkspace(index, id));
  return { id, previous, changed: true };
}

/** Give a workspace a name a person recognises, without changing what is open. */
export async function nameWorkspace(
  fs: FileSystemPort,
  id: string,
  entry: { label: string; server_url: string },
): Promise<void> {
  await writeWorkspaceIndexFile(fs, withWorkspaceEntry(readWorkspaceIndexFile(), id, entry));
}
