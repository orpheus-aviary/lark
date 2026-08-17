// 0002-sync-activation — schema v2 (v0.2 plan §4.3): turn the sync tables 0001
// built empty into a working outbox, and add the four tables the sync engine
// needs to survive a crash.
//
// INVARIANT: Once shipped, this file is IMMUTABLE. Forward changes go into
// 0003-*.ts and beyond — never edit this one.
//
// This migration writes NO sync_changes rows. The full backfill (create ops
// for every existing song / playlist / membership, plus a `set_lyrics` per
// stored .lrc) runs at LOGIN time instead, driven by the two generation keys
// seeded below — owl learned the hard way that a migration which both writes
// the outbox and reads its history stops being replayable, and a SQL migration
// cannot read the filesystem to find the lyrics at all (R4-1).
//
// user_version is NOT set here — applyForwardMigrations() stamps it inside the
// same transaction after this SQL succeeds.

export const version = 2;

export const sql = `
-- Persistent tombstones. A delete has to outlive the outbox row that carried
-- it: retention trims sync_changes, and once the change is gone the only proof
-- that "missing" means "deleted" rather than "never seen" is this table.
-- device_id is nullable to match the entity tables; comparison reads NULL as ''.
CREATE TABLE sync_tombstones (
  entity_type TEXT NOT NULL
                CHECK (entity_type IN ('song','playlist','playlist_song')),
  entity_id   TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  lww_counter INTEGER NOT NULL DEFAULT 0,
  device_id   TEXT,
  deleted_at  INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

-- The file-effect journal: every file consequence of a sync decision, written
-- in the SAME transaction as the DB change that implies it. Crash between the
-- commit and the unlink and the pending row is still there at boot.
--
-- arg holds the decision's full snapshot (including the op_uuid generated
-- before the row was written, which the quarantine path derives its target
-- from) so the executor never re-derives anything: by the time it runs, the
-- row it would have consulted is gone.
CREATE TABLE sync_file_ops (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL
                  CHECK (kind IN ('delete_song_files','quarantine_song_files',
                                  'write_lyrics','delete_lyrics')),
  song_id       TEXT NOT NULL,
  arg           TEXT,
  created_at    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_retry_at INTEGER
);

-- Ops for one song execute in strict id order; different songs overtake freely.
CREATE INDEX idx_sync_file_ops_song ON sync_file_ops(song_id, id);

-- Changes that could not be applied or emitted. Inbound rows keep the COMPLETE
-- wire envelope in payload (the columns beside it are extracted for lookup
-- only) so a bug found later can be diagnosed, and replayed, from the archive.
-- Outbound rows keep a summary — the thing that failed was too big by
-- definition.
CREATE TABLE sync_dead_letters (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  direction        TEXT NOT NULL CHECK (direction IN ('in','out')),
  server_seq       INTEGER,
  client_change_id TEXT,
  device_id        TEXT,
  entity_type      TEXT,
  entity_id        TEXT,
  op               TEXT,
  payload          TEXT,
  reason           TEXT NOT NULL,
  recorded_at      INTEGER NOT NULL
);

CREATE INDEX idx_sync_dead_letters_recent
  ON sync_dead_letters(direction, recorded_at DESC);

-- Which workspace this library belongs to, written once at first login and
-- never updated. Every later login checks all four fields: a login that would
-- point the same library at a second workspace is refused, not merged.
CREATE TABLE sync_binding (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  server_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  bound_at       INTEGER NOT NULL
);

-- conflict_record gains the other two thirds of the LWW key (owl 0011).
-- Display-only, all nullable: LWW comparison is unchanged, but a conflict page
-- that shows only milliseconds cannot explain a same-millisecond loss.
ALTER TABLE conflict_record ADD COLUMN local_lww_counter  INTEGER;
ALTER TABLE conflict_record ADD COLUMN remote_lww_counter INTEGER;
ALTER TABLE conflict_record ADD COLUMN local_device_id    TEXT;
ALTER TABLE conflict_record ADD COLUMN remote_device_id   TEXT;

-- The cursor is keyed by (server_id, workspace_id), not by a URL string: the
-- same server reached as https://host and https://host/ is one server, and a
-- URL key would silently restart the pull from zero after a config edit.
-- Dropping is safe rather than destructive — v0.1 never wrote a single sync
-- row (R2), so this table is empty by construction on every existing install.
DROP TABLE sync_cursor;

CREATE TABLE sync_cursor (
  server_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  pulled_seq   INTEGER NOT NULL DEFAULT 0,
  pushed_seq   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (server_id, workspace_id)
);

-- Per-entity lookups into the outbox, which v0.2 does on two hot paths: the
-- backfill's "does a create op already exist for this row" guard, and the
-- lyrics backfill's "is there a pending set_lyrics for this song" stale check.
-- Both are per-entity probes and would otherwise scan the whole outbox.
CREATE INDEX idx_sync_changes_entity
  ON sync_changes(entity_type, entity_id, op);

-- (provider, key) stops being UNIQUE (D8). Two devices can legitimately
-- download the same video into the same library while both are offline, and
-- there is no merge that is safe regardless of arrival order — so duplicates
-- are allowed to land, surfaced in the UI, and cleaned up by the user. The
-- local paths that used to lean on this index keep refusing duplicates
-- themselves; only sync can create one.
DROP INDEX idx_songs_source_key;

CREATE INDEX idx_songs_source_key ON songs(source_provider, source_key)
  WHERE source_provider IS NOT NULL;

-- Backfill generations. done < target means "this library still owes the
-- server a full set of create ops"; the next login runs the backfill inside
-- its install transaction and levels them. unbind bumps target again, which is
-- what makes a re-bind replay everything without a migration.
INSERT INTO local_metadata (key, value) VALUES
  ('sync_backfill_done_generation', '0'),
  ('sync_backfill_target_generation', '1')
  ON CONFLICT(key) DO NOTHING;
`;
