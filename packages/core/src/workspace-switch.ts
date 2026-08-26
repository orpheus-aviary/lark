// Changing which workspace this device opens (N7e, §2.5).
//
// ONE LINE IN ONE FILE, and that is the whole operation. Nothing is moved,
// nothing is copied, nothing is closed: the process carries on serving the
// library it already has open, because `resolveActiveWorkspace()` is settled
// once per process. A switch that had done anything else would be a switch
// that could be half-done.
//
// So "restart to take effect" is not an apology for an unfinished feature —
// it is what makes the feature safe. §3① lists what would have to be
// re-entered to swap a library under a running process: the download engine's
// claim registry, the sync coordinator's session, the player's audio session,
// the file-op journal runtime. Every one of them is a once-per-process gate,
// and the phone additionally has expo-sqlite's Activity-restart bug living
// exactly there.
//
// THE WRITE IS ATOMIC, so "somebody killed it right after" is the same state
// as "it finished": the index either names the old workspace or the new one,
// never half a name (criterion 115).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  WORKSPACES_FILE_NAME,
  readWorkspaceIndex,
  writeWorkspaceIndex,
} from './config/workspaces.js';
import { invalidateActiveWorkspace, larkDir, workspacePaths, workspacesPath } from './paths.js';
import type { StructuredLogger } from './portable/logger.js';
import { withActiveWorkspace } from './portable/workspace-index.js';
import { WORKSPACE_LOCAL, isWorkspaceId } from './portable/workspace.js';

export interface SwitchWorkspaceResult {
  /** What the index now names. */
  id: string;
  /** What it named before. Equal to `id` when the switch was a no-op. */
  previous: string;
  /** False when the device was already pointing there. */
  changed: boolean;
}

/**
 * Point this device at `id`. Takes effect at the next launch.
 *
 * 🔴 THE LIBRARY HAS TO BE THERE FIRST. `decideActiveWorkspace` gates on
 * `libraries/<id>/songs.db`, so writing `active` for a workspace that has not
 * been prepared yet would produce a switch that silently falls back to
 * `local` — the worst possible outcome, because it looks like the switch
 * worked and then shows an empty library. Refusing here is what makes
 * "prepare, then switch" the only order that exists.
 */
export function switchWorkspace(id: string, logger?: StructuredLogger): SwitchWorkspaceResult {
  if (!isWorkspaceId(id)) throw new Error(`not a workspace id: ${id}`);
  if (id !== WORKSPACE_LOCAL && !existsSync(workspacePaths(id).db)) {
    throw new Error(`there is no library at ${workspacePaths(id).root} — prepare it first`);
  }

  const path = workspacesPath();
  const index = readWorkspaceIndex(path, logger);
  const previous = index.active;
  if (previous === id) return { id, previous, changed: false };

  writeWorkspaceIndex(withActiveWorkspace(index, id), path);
  // Only for THIS process, which is about to be told to restart anyway: what
  // it changes is the answer a later `paths.dbPath()` would give, and the
  // caller is the one place that wants that to be true immediately.
  invalidateActiveWorkspace();
  logger?.info({ from: previous, to: id }, 'the active workspace changed — restart to open it');
  return { id, previous, changed: true };
}

/** Whether this device has an index at all — i.e. has ever switched. */
export function hasWorkspaceIndex(): boolean {
  return existsSync(join(larkDir(), WORKSPACES_FILE_NAME));
}
