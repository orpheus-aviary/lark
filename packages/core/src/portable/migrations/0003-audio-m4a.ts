// 0003-audio-m4a — schema v3 (0.3.0, master plan §3.2-2/§3.2-8): the ledger
// for the one-time mp3 → m4a conversion, and the flag that says this library
// still owes it.
//
// INVARIANT: Once shipped, this file is IMMUTABLE. Forward changes go into
// 0004-*.ts and beyond — never edit this one.
//
// The flag is set HERE, in the migration's own transaction, and that placement
// is the whole point. `applyForwardMigrations` commits the SQL and the
// `PRAGMA user_version = 3` stamp together, so there is no instant at which a
// library is v3 (= "this build understands you") without also being marked as
// owing the conversion. Writing the flag in a second statement afterwards
// would open exactly that window, and a process that died inside it would come
// back as a normal v3 library whose `song.mp3` files nothing ever looks at
// again.
//
// The opposite window is harmless and is where the clear lives instead: a
// BRAND NEW library runs 0001..0003 and then has `createDatabase` clear the
// flag, because a library nobody has ever written a song into cannot be
// holding an mp3. Dying between the commit and the clear costs one empty scan
// on the next boot. Fail-closed in the direction of migrating too often.

export const version = 3;

export const sql = `
-- One row per OBJECT, not per song. The key is the directory name under
-- songs/, because the scanner walks that tree rather than the songs table: an
-- old file-effect journal can name a song that was deleted, and a directory
-- left behind by a crash need not be a UUID at all. Keying by song_id would
-- either lose those rows or invent library entries for them.
--
-- song_id is therefore nullable and carries NO foreign key: it is what this
-- object appears to belong to, which may be nothing.
CREATE TABLE audio_migration (
  object_key         TEXT PRIMARY KEY,
  song_id            TEXT,
  -- R = rebuildable (downloaded, with a usable source), A = asset (imported,
  -- or anything that fails R's conditions), orphan = not a library song.
  class              TEXT NOT NULL CHECK (class IN ('R','A','orphan')),
  file_origin        TEXT,
  source_key_present INTEGER NOT NULL DEFAULT 0
                       CHECK (source_key_present IN (0,1)),
  status             TEXT NOT NULL
                       CHECK (status IN ('pending','converting','discarding',
                                         'backing_up','done','lost',
                                         'kept_unconverted','asset_missing',
                                         'blocked','blocked_file_op')),
  -- Which file action failed, for a 'blocked' row, and where to resume from
  -- (including the intent a 'backing_up' row was carrying: done | kept).
  blocked_action     TEXT,
  resume_state       TEXT,
  error_class        TEXT CHECK (error_class IS NULL OR
                                 error_class IN ('abort','environment',
                                                 'content','file_action')),
  last_error         TEXT,
  -- RELATIVE to the lark nest root, never absolute: a nest can be copied with
  -- \`backup-nest\` and reopened elsewhere through LARK_NEST_DIR, and an
  -- absolute path would make the ledger's own backups unresolvable there.
  backup_path        TEXT,
  -- Set when a file turned up somewhere the state machine had already finished
  -- with, and was moved to a collision-safe name instead of being deleted.
  reconcile_action   TEXT,
  at                 INTEGER NOT NULL
);

-- The runner picks up work by status, and the report counts by it.
CREATE INDEX idx_audio_migration_status ON audio_migration(status);

-- Set unconditionally: every library reaching v3 is assumed to owe the
-- conversion until a scan proves otherwise. createDatabase clears it again for
-- a library that was created by this same call.
INSERT INTO local_metadata (key, value) VALUES ('audio_migration_pending', '1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`;
