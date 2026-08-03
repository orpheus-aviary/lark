// Programmatic Go-era songs.db fixture (T5). The DDL is taken verbatim from
// lark-go `internal/db/db.go` — including the `duration` column arriving via
// ALTER (reproducing the physical column order of real libraries). The
// default dataset replicates the REAL library's shape (§2.1): position holes
// starting past 1, an `is_system=1` all-playlist with materialized members,
// `+08:00` offset timestamps without fractional seconds, empty artists, a
// negative lyrics_offset.
//
// Test support only — never run against the real nest.
// (`.exec` here is better-sqlite3's Database#exec — SQL, not child_process.)

import { randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';

export interface GoSongSeed {
  id: string;
  name: string | null;
  artist?: string | null;
  created_at: string;
  lyrics_offset?: number | null;
  duration?: number | null;
}

export interface GoPlaylistSeed {
  id: string;
  list_name: string;
  is_system: 0 | 1;
}

export interface GoMemberSeed {
  playlist_id: string;
  song_id: string;
  position: number;
}

export interface GoLegacySeed {
  songs: GoSongSeed[];
  playlists: GoPlaylistSeed[];
  members: GoMemberSeed[];
}

export interface SeedOptions {
  /** Omit the ALTER-added duration column (very old library shape, M1-9). */
  withoutDuration?: boolean;
  /**
   * Drop the NOT NULL on songs.name — real Go DDL has it, but the migration
   * must abort cleanly (with the song id) on libraries that don't.
   */
  nullableName?: boolean;
}

/** The real sample timestamp from the live library (§2.1). */
export const REAL_SAMPLE_TIMESTAMP = '2026-02-23T03:53:29+08:00';

/**
 * Default dataset mirroring the real library's shape: 20 songs, 3 playlists
 * (all + 2 user), 24 memberships (20 materialized under all, 4 elsewhere).
 * Post-migration expectation: 20 songs / 2 playlists / 4 memberships.
 */
export function defaultGoSeed(): GoLegacySeed {
  const songs: GoSongSeed[] = [];
  for (let i = 0; i < 20; i++) {
    songs.push({
      id: randomUUID(),
      name: `歌曲${String(i + 1).padStart(2, '0')}`,
      artist: i % 2 === 0 ? '' : '测试歌手',
      created_at:
        i === 0
          ? REAL_SAMPLE_TIMESTAMP
          : `2026-03-${String(i + 1).padStart(2, '0')}T12:0${i % 10}:00+08:00`,
      lyrics_offset: i === 1 ? -26.5 : 0,
      duration: 180 + i,
    });
  }

  const all: GoPlaylistSeed = { id: randomUUID(), list_name: 'all', is_system: 1 };
  const p1: GoPlaylistSeed = { id: randomUUID(), list_name: '收藏', is_system: 0 };
  const p2: GoPlaylistSeed = { id: randomUUID(), list_name: '通勤', is_system: 0 };

  // all members: positions 4..26 with holes at 7, 12, 19 → exactly 20 rows
  const positions: number[] = [];
  for (let p = 4; p <= 26; p++) {
    if (p === 7 || p === 12 || p === 19) continue;
    positions.push(p);
  }
  const members: GoMemberSeed[] = songs.map((s, i) => ({
    playlist_id: all.id,
    song_id: s.id,
    position: positions[i],
  }));
  // user playlists: non-1 starting positions with holes
  members.push({ playlist_id: p1.id, song_id: songs[0].id, position: 2 });
  members.push({ playlist_id: p1.id, song_id: songs[3].id, position: 5 });
  members.push({ playlist_id: p2.id, song_id: songs[1].id, position: 3 });
  members.push({ playlist_id: p2.id, song_id: songs[4].id, position: 7 });

  return { songs, playlists: [all, p1, p2], members };
}

/** Create a Go-era songs.db at `dbPath` and return the seed used. */
export function seedGoLegacyDb(
  dbPath: string,
  seed: GoLegacySeed = defaultGoSeed(),
  options: SeedOptions = {},
): GoLegacySeed {
  const sqlite = new BetterSqlite3(dbPath);
  try {
    // DDL verbatim from lark-go db.go (name NOT NULL optionally lifted).
    sqlite.exec(`
	CREATE TABLE IF NOT EXISTS songs (
		id TEXT PRIMARY KEY,
		name TEXT${options.nullableName ? '' : ' NOT NULL'},
		artist TEXT DEFAULT '',
		created_at TEXT NOT NULL,
		lyrics_offset REAL DEFAULT 0.0
	);

	CREATE TABLE IF NOT EXISTS playlists (
		id TEXT PRIMARY KEY,
		list_name TEXT NOT NULL,
		is_system INTEGER DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS playlist_songs (
		playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
		song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
		position INTEGER NOT NULL,
		PRIMARY KEY (playlist_id, song_id)
	);
	`);
    if (!options.withoutDuration) {
      sqlite.exec('ALTER TABLE songs ADD COLUMN duration REAL DEFAULT 0');
    }

    const insertSong = options.withoutDuration
      ? sqlite.prepare(
          'INSERT INTO songs (id, name, artist, created_at, lyrics_offset) VALUES (?, ?, ?, ?, ?)',
        )
      : sqlite.prepare(
          'INSERT INTO songs (id, name, artist, created_at, lyrics_offset, duration) VALUES (?, ?, ?, ?, ?, ?)',
        );
    for (const s of seed.songs) {
      const base = [s.id, s.name, s.artist ?? '', s.created_at, s.lyrics_offset ?? 0];
      if (options.withoutDuration) insertSong.run(...base);
      else insertSong.run(...base, s.duration ?? 0);
    }

    const insertPlaylist = sqlite.prepare(
      'INSERT INTO playlists (id, list_name, is_system) VALUES (?, ?, ?)',
    );
    for (const p of seed.playlists) {
      insertPlaylist.run(p.id, p.list_name, p.is_system);
    }

    const insertMember = sqlite.prepare(
      'INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)',
    );
    for (const m of seed.members) {
      insertMember.run(m.playlist_id, m.song_id, m.position);
    }
  } finally {
    sqlite.close();
  }
  return seed;
}
