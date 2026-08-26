// Making a workspace for an account that does not have one on this phone yet
// (N7e-4, §2.6).
//
// The desktop's `core/workspace-prepare.ts` is the same three cases and the
// same staging-then-rename shape; what differs is every mechanism underneath,
// because this host has neither `cp -r` nor a read-only SQLite open.
//
// 🔴 CLAIM IS A COPY AND NEVER A MOVE (owl's rule, inherited): after it the
// library somebody has been using offline is byte-for-byte what it was — still
// openable, still playable, still bound to nothing. The audio comes with it,
// so the new workspace plays instead of showing every song as needing a
// download (the user's decision, N7e).
//
// 🔴 AND IT CLAIMS A D16 IDENTITY BEFORE THE WORKSPACE EXISTS. Without that,
// the first boot into the new workspace would find a library carrying somebody
// else's `install_id` and no committed identity of its own — which is exactly
// the signature of a restored backup — and CONVERGE, wiping the binding and
// the credentials this login is about to write. The order below is the boot
// sequence's own: SecureStore intent first, then the library, then the commit.
//
// BUILT IN A STAGING DIRECTORY AND MOVED INTO PLACE. `libraries/<id>/` is what
// `decideActiveWorkspace` gates on, so it must never exist half-built; a
// directory move onto a name that does not exist is a rename, and anything
// left in `.incoming-*` after a crash names no workspace and blocks nothing.

import { type PortableDb, isAccountWorkspaceId, prepareLibrary, uuid } from '@lark/core/portable';
import type { WorkspaceOriginChoice } from '@lark/shared';
import { Directory, File } from 'expo-file-system';
import { openDatabaseSync } from 'expo-sqlite';
import { portableDbOf } from '../db/portable-db';
import { claimFreshLibrary } from '../identity/converge';
import { commitIdentity, writeIntent } from '../identity/store';
import {
  DATABASE_NAME,
  librariesDirectory,
  libraryDirectory,
  workspaceDirectory,
} from '../ports/paths';

const SONGS_DIRECTORY = 'songs';

export interface PrepareWorkspaceInput {
  id: string;
  origin: WorkspaceOriginChoice;
  /** The library this phone has open — the source of a claim. */
  source: PortableDb;
}

export interface PreparedWorkspace {
  id: string;
  /** False when the account already had a workspace here and nothing was done. */
  created: boolean;
  origin: WorkspaceOriginChoice | 'existing';
}

/**
 * Fold the write-ahead log back into the database, so a file copy is whole.
 *
 * This app is the only writer and this runs inside a user's tap, so a
 * checkpoint is enough — no snapshot dance, unlike the identity probe, which
 * has to read a library it is not allowed to touch.
 */
function settle(source: PortableDb): void {
  source.sqlite.pragma('wal_checkpoint(TRUNCATE)');
}

/** An empty library at the current schema, built where nothing is watching. */
function createEmptyLibrary(directory: Directory): void {
  const handle = openDatabaseSync(DATABASE_NAME, {}, directory.uri);
  try {
    const db = portableDbOf(handle);
    db.sqlite.pragma('busy_timeout = 5000');
    prepareLibrary(db.sqlite, `${directory.uri}/${DATABASE_NAME}`, {
      onVerdict: () => {
        db.sqlite.pragma('journal_mode = WAL');
      },
    });
  } finally {
    handle.closeSync();
  }
}

/** Stamp the new library with an identity this install owns (D16). */
async function claimIdentity(directory: Directory, workspaceId: string): Promise<void> {
  const installId = uuid();
  // SecureStore first, database second — the frozen order (§2.2.1). A crash
  // between them leaves an intent the next boot into this workspace redoes
  // verbatim; the other way round leaves a library with no identity, which is
  // indistinguishable from a restored one.
  writeIntent({ id: installId, purpose: 'fresh' }, workspaceId);

  const handle = openDatabaseSync(DATABASE_NAME, {}, directory.uri);
  try {
    claimFreshLibrary(portableDbOf(handle), installId);
  } finally {
    handle.closeSync();
  }
  await commitIdentity(installId, workspaceId);
}

/**
 * Make sure `libraries/<id>/` holds a library, and answer what it took.
 *
 * Idempotent by the only test that matters: a workspace whose `songs.db` is
 * already there is left exactly as it is, which is what makes logging into the
 * same account twice land on one copy rather than growing a second.
 */
export async function prepareWorkspace(input: PrepareWorkspaceInput): Promise<PreparedWorkspace> {
  const { id, origin, source } = input;
  if (!isAccountWorkspaceId(id)) throw new Error(`not an account workspace id: ${id}`);

  const target = workspaceDirectory(id);
  if (new File(target, DATABASE_NAME).exists) {
    return { id, created: false, origin: 'existing' };
  }

  const libraries = librariesDirectory();
  if (!libraries.exists) libraries.create({ intermediates: true });
  const staging = new Directory(libraries, `.incoming-${id}`);
  if (staging.exists) staging.delete();
  staging.create({ intermediates: true });

  try {
    if (origin === 'claim') {
      settle(source);
      new File(libraryDirectory(), DATABASE_NAME).copySync(new File(staging, DATABASE_NAME));
      const songs = new Directory(libraryDirectory(), SONGS_DIRECTORY);
      if (songs.exists) songs.copySync(new Directory(staging, SONGS_DIRECTORY));
    } else {
      createEmptyLibrary(staging);
    }

    // Before the move, so the workspace only ever appears WITH an identity.
    await claimIdentity(staging, id);
    staging.move(target);
  } catch (err) {
    if (staging.exists) staging.delete();
    throw err;
  }

  return { id, created: true, origin };
}
