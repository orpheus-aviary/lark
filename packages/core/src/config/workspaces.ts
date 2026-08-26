// Reading and writing `lark/workspaces.toml` (N7b).
//
// The desktop half of the workspace index: TOML in, TOML out, and everything
// about what it MEANS delegated to `portable/workspace-index.ts` — which is
// also what the phone's `workspaces.json` goes through. Two encodings, one set
// of rules, and criterion 107 checked in a place that does not need either
// host.
//
// NOT credential material, unlike `skybridge.toml` beside it: an id, a label
// and a server url. So it is an ordinary 0644 file, and a nest backup keeps it
// — restoring a nest onto a fresh machine should come up pointing at the same
// workspace it was pointing at.
//
// WRITTEN ATOMICALLY ANYWAY. It is the file that decides which library this
// device opens, and a reader that caught it half-written would fall back to
// `local` — which, on a device whose real library is under `libraries/`, looks
// exactly like an empty library.

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import type { StructuredLogger } from '../portable/logger.js';
import {
  DEFAULT_WORKSPACE_INDEX,
  type WorkspaceIndex,
  parseWorkspaceIndex,
  serializeWorkspaceIndex,
} from '../portable/workspace-index.js';

/**
 * The device's workspace index, by name.
 *
 * The constants live HERE and not in `paths.ts`, which re-exports them: the
 * resolver in `paths.ts` calls into this module, so a dependency back the
 * other way would be a cycle between the two files a boot cannot start
 * without.
 */
export const WORKSPACES_FILE_NAME = 'workspaces.toml';
export const WORKSPACES_TEMP_PREFIX = '.workspaces.toml.tmp-';

/**
 * The index, or the device that has never switched.
 *
 * Never throws: every entry point calls this before it can open anything, and
 * a boot that dies on a malformed settings file is a boot that cannot be
 * recovered from without a text editor.
 */
export function readWorkspaceIndex(filePath: string, logger?: StructuredLogger): WorkspaceIndex {
  if (!existsSync(filePath)) return DEFAULT_WORKSPACE_INDEX;

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    logger?.warn(
      { path: filePath, err: String(err) },
      'workspaces.toml could not be parsed — this device opens its local library',
    );
    return DEFAULT_WORKSPACE_INDEX;
  }
  return parseWorkspaceIndex(parsed, logger);
}

/**
 * Replace the file atomically.
 *
 * Whole-file rewrite, no merge with what is on disk — the caller holds the
 * complete index it wants (it just switched, or registered a workspace), and
 * merging would let a replaced `active` outlive its replacement.
 */
export function writeWorkspaceIndex(index: WorkspaceIndex, filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = join(dir, `${WORKSPACES_TEMP_PREFIX}${randomUUID()}`);
  const fd = openSync(tmpPath, 'wx', 0o644);
  try {
    writeSync(fd, stringify(serializeWorkspaceIndex(index)));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort temp cleanup — the rename error is the one that matters */
    }
    throw err;
  }
}
