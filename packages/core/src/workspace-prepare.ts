// Making a workspace for an account that does not have one yet (N7e, §2.6).
//
// A login can land in one of three places, and only the first needs no work:
//
//   the account ALREADY has a workspace here   open it, nothing to prepare
//   claim  — this library becomes the account's  copy it, whole
//   fresh  — the account starts empty            create an empty library
//
// 🔴 CLAIM IS A COPY AND NEVER A MOVE. owl's `local-inspect.ts` states the
// rule and lark inherits it: account sync must never write the library
// somebody has been using offline. After a claim the original is byte-for-byte
// what it was — still openable, still playable, still not bound to anything
// (criterion 117). The user chose that in N7e: the audio is copied too, so the
// new workspace plays immediately rather than showing every song as "needs
// downloading".
//
// BUILT IN A STAGING DIRECTORY AND RENAMED INTO PLACE, which is where the
// crash-safety comes from. `libraries/<id>/` is what `decideActiveWorkspace`
// gates on, so it must never exist half-built: a rename of a directory onto a
// name that does not exist is atomic, and anything left in `.incoming-*` after
// a crash is garbage that names no workspace and blocks nothing.
//
// THE DATABASE IS COPIED WITH SQLITE'S ONLINE BACKUP, not with `cp`. The
// caller is the daemon and the daemon is the writer, so the file on disk is a
// moving target; `backupDatabase` is the same call the nest backup uses and
// for the same reason.

import { existsSync } from 'node:fs';
import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { backupDatabase } from './db/backup.js';
import { createDatabase } from './db/index.js';
import {
  WORKSPACE_DB_FILE,
  WORKSPACE_SONGS_SUBDIR,
  librariesDir,
  workspacePaths,
} from './paths.js';
import type { StructuredLogger } from './portable/logger.js';
import { isAccountWorkspaceId } from './portable/workspace.js';

/** What a login wants done before it installs. */
export type WorkspaceOrigin = 'claim' | 'fresh';

export interface PrepareWorkspaceOptions {
  /** The account's workspace id. Never `local` — that one always exists. */
  id: string;
  origin: WorkspaceOrigin;
  /**
   * The library to copy, for `claim`. The caller's OPEN handle: an online
   * backup off a live database is exactly what this is for.
   */
  source?: BetterSqlite3.Database;
  /** `songs/` of the workspace being claimed. Copied whole. */
  sourceSongs?: string;
  logger?: StructuredLogger;
}

export interface PreparedWorkspace {
  id: string;
  /** False when the account already had a workspace here and nothing was done. */
  created: boolean;
  origin: WorkspaceOrigin | 'existing';
}

/**
 * Make sure `libraries/<id>/` holds a library, and answer what it took.
 *
 * Idempotent by the only test that matters: a workspace whose `songs.db` is
 * already there is left exactly as it is. That is also what makes logging into
 * the same account twice land on the same copy rather than growing a second.
 */
export async function prepareWorkspace(
  options: PrepareWorkspaceOptions,
): Promise<PreparedWorkspace> {
  const { id, origin, logger } = options;
  if (!isAccountWorkspaceId(id)) {
    throw new Error(`not an account workspace id: ${id}`);
  }

  const target = workspacePaths(id);
  if (existsSync(target.db)) {
    logger?.info({ id }, 'the account already has a workspace on this device');
    return { id, created: false, origin: 'existing' };
  }

  await mkdir(librariesDir(), { recursive: true });
  // A name no workspace can have — `isWorkspaceId` rejects it — so a listing
  // that only accepts ids cannot mistake a half-built one for a workspace.
  const staging = join(librariesDir(), `.incoming-${id}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: false });

  try {
    if (origin === 'claim') {
      const source = options.source;
      if (source === undefined) throw new Error('claiming a workspace needs a source library');
      await backupDatabase(source, join(staging, WORKSPACE_DB_FILE));
      if (options.sourceSongs !== undefined && existsSync(options.sourceSongs)) {
        // The user's choice (N7e): the audio comes too, so the new workspace
        // plays rather than showing every song as "needs downloading". The
        // original keeps its own copy — this is the whole point of a claim
        // being a copy.
        await cp(options.sourceSongs, join(staging, WORKSPACE_SONGS_SUBDIR), {
          recursive: true,
          preserveTimestamps: true,
        });
      }
    } else {
      // An empty library at the current schema, which is what `createDatabase`
      // builds from nothing.
      // No logger: `createDatabase` wants pino's, and there is nothing here
      // worth a second logging type — an empty library has no history to say
      // anything about.
      const { sqlite } = createDatabase({ dbPath: join(staging, WORKSPACE_DB_FILE) });
      sqlite.close();
    }

    // The one moment the workspace comes into existence.
    await rename(staging, target.root);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }

  logger?.info({ id, origin }, 'prepared a workspace for this account');
  return { id, created: true, origin };
}
