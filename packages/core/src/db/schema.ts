// drizzle definitions (M1-2): final-state schema only — DDL history lives in
// migrations/. Property names are snake_case and timestamps are unix-ms
// numbers, so query results are already wire-shaped (no mapping layer).
// The sync tables are deliberately NOT here: v0.1 never reads or writes them
// (M1-11); they exist as raw DDL in 0001-init.

import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const songs = sqliteTable('songs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  artist: text('artist').notNull().default(''),
  source_url: text('source_url'),
  source_provider: text('source_provider'),
  source_key: text('source_key'),
  file_origin: text('file_origin', { enum: ['downloaded', 'imported'] })
    .notNull()
    .default('downloaded'),
  lyrics_offset: real('lyrics_offset').notNull().default(0),
  duration: real('duration').notNull().default(0),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  last_accessed_at: integer('last_accessed_at', { mode: 'number' }),
  created_at: integer('created_at', { mode: 'number' }).notNull(),
  updated_at: integer('updated_at', { mode: 'number' }).notNull(),
  device_id: text('device_id'),
  lww_counter: integer('lww_counter', { mode: 'number' }).notNull().default(0),
});

export const playlists = sqliteTable('playlists', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  created_at: integer('created_at', { mode: 'number' }).notNull(),
  updated_at: integer('updated_at', { mode: 'number' }).notNull(),
  device_id: text('device_id'),
  lww_counter: integer('lww_counter', { mode: 'number' }).notNull().default(0),
});

export const playlist_songs = sqliteTable(
  'playlist_songs',
  {
    playlist_id: text('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    song_id: text('song_id')
      .notNull()
      .references(() => songs.id, { onDelete: 'cascade' }),
    rank: real('rank').notNull(),
    added_at: integer('added_at', { mode: 'number' }).notNull(),
    updated_at: integer('updated_at', { mode: 'number' }).notNull(),
    device_id: text('device_id'),
    lww_counter: integer('lww_counter', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.playlist_id, t.song_id] })],
);

export const local_metadata = sqliteTable('local_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export type SongRow = typeof songs.$inferSelect;
export type PlaylistRow = typeof playlists.$inferSelect;
export type PlaylistSongRow = typeof playlist_songs.$inferSelect;
