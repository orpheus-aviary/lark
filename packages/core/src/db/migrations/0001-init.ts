// 0001-init — schema v1 (master plan §3.1): songs / playlists / playlist_songs
// / local_metadata + the skybridge sync tables in owl's 0004+0005+0007 final
// form (built empty; v0.1 never writes them, R2).
//
// INVARIANT: Once shipped, this file is IMMUTABLE. Forward changes go into
// 0002-*.ts and beyond — never edit this one.
//
// user_version is NOT set here — applyForwardMigrations() stamps it inside
// the same transaction after this SQL succeeds.

export const version = 1;

export const sql = `
CREATE TABLE songs (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  artist           TEXT NOT NULL DEFAULT '',
  source_url       TEXT,
  source_provider  TEXT,
  source_key       TEXT,
  file_origin      TEXT NOT NULL DEFAULT 'downloaded'
                     CHECK (file_origin IN ('downloaded','imported')),
  lyrics_offset    REAL NOT NULL DEFAULT 0,
  duration         REAL NOT NULL DEFAULT 0,
  pinned           INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  last_accessed_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  device_id        TEXT,
  lww_counter      INTEGER NOT NULL DEFAULT 0,
  CHECK ((source_provider IS NULL) = (source_key IS NULL))
);

CREATE UNIQUE INDEX idx_songs_source_key ON songs(source_provider, source_key)
  WHERE source_provider IS NOT NULL;

CREATE TABLE playlists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  device_id   TEXT,
  lww_counter INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE playlist_songs (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  song_id     TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  rank        REAL NOT NULL,
  added_at    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  device_id   TEXT,
  lww_counter INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (playlist_id, song_id)
);

CREATE INDEX idx_playlist_songs_song ON playlist_songs(song_id);

CREATE TABLE local_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sync_changes (
  local_seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id        TEXT NOT NULL,
  entity_type      TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  op               TEXT NOT NULL,
  payload          TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  client_change_id TEXT,
  server_seq       INTEGER,
  synced_at        INTEGER
);

CREATE INDEX idx_sync_changes_created ON sync_changes(created_at);
CREATE UNIQUE INDEX idx_sync_changes_cid ON sync_changes(client_change_id);
CREATE INDEX idx_sync_changes_pending
  ON sync_changes(synced_at)
  WHERE synced_at IS NULL;

CREATE TABLE sync_cursor (
  endpoint    TEXT PRIMARY KEY,
  pulled_seq  INTEGER NOT NULL DEFAULT 0,
  pushed_seq  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE conflict_record (
  id                   TEXT PRIMARY KEY,
  entity_type          TEXT NOT NULL,
  entity_id            TEXT NOT NULL,
  local_seq            INTEGER,
  remote_seq           INTEGER,
  detected_at          INTEGER NOT NULL,
  resolved_at          INTEGER,
  resolution           TEXT,
  losing_side          TEXT,
  local_payload        TEXT,
  remote_payload       TEXT,
  local_updated_at_ms  INTEGER,
  remote_updated_at_ms INTEGER
);

CREATE INDEX idx_conflict_unresolved
  ON conflict_record(detected_at DESC)
  WHERE resolved_at IS NULL;
`;
