// Song payload files: the audio path, and lyrics read/delete (M2 T6).
//
// Every path is built HERE, from an id that has passed the UUID gate first
// (R10) — `songs/<id>/` is a real filesystem location, so an id that reaches a
// join without being validated is a traversal waiting to happen. Callers must
// never assemble these paths themselves.
//
// Lyrics live beside the audio as `lyrics.lrc` but are NOT audio: they are
// tiny, they cannot be re-derived from a source key, and they never
// participate in cache eviction (R1/R26). Deleting one is an explicit user
// action, which is why `deleteLyrics` exists and no "delete the song's files"
// helper does. M3's lyrics download writes through this same module.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isUuidV4 } from '@lark/shared';
import { type LarkDatabase, sqliteOf } from '../db/index.js';
import { InvalidIdError, SyncChangeTooLargeError } from '../errors.js';
import { songsDir } from '../paths.js';
import { emitSyncChange, recordDeadLetter } from '../sync/changes.js';

/** `songs/<id>/` — throws InvalidIdError before touching the filesystem. */
export function songDirPath(id: string): string {
  if (!isUuidV4(id)) throw new InvalidIdError(id);
  return join(songsDir(), id);
}

/**
 * The one audio file name in the library (0.3.0). Everything writes it and
 * everything reads it; there is no probing and no second format.
 */
export const CANONICAL_AUDIO_FILE = 'song.m4a';

/**
 * What 0.2.x wrote. Only two kinds of code may mention it: the one-time
 * migration, and the `has_file` probe while that migration is still pending
 * (a song not converted yet is present, and reporting it as missing would
 * offer the user a download for a file they already have).
 */
export const LEGACY_AUDIO_FILE = 'song.mp3';

/** `songs/<id>/song.m4a` */
export function songAudioPath(id: string): string {
  return join(songDirPath(id), CANONICAL_AUDIO_FILE);
}

/** `songs/<id>/song.mp3` — pre-0.3.0 audio. Migration and `has_file` only. */
export function legacySongAudioPath(id: string): string {
  return join(songDirPath(id), LEGACY_AUDIO_FILE);
}

/** `songs/<id>/lyrics.lrc` */
export function songLyricsPath(id: string): string {
  return join(songDirPath(id), 'lyrics.lrc');
}

/** LRC text, or `null` when the song has no lyrics file. */
export async function readLyrics(id: string): Promise<string | null> {
  try {
    return await readFile(songLyricsPath(id), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write (or replace) the lyrics file atomically — temp sibling then rename, so
 * a crash mid-write can never leave a half-file where working lyrics were
 * (R22). The temp name is random rather than derived from the song id: two
 * writers for the same song would otherwise share one temp path and the loser
 * would rename the winner's half-written bytes into place.
 *
 * Empty content is refused. "No lyrics" is the absence of the file, which is
 * what `readLyrics` reports as `null`; a zero-byte file would read as lyrics
 * that exist and say nothing.
 */
export async function writeLyricsFile(id: string, lrc: string): Promise<void> {
  const dir = songDirPath(id); // validates the id before any path is built
  if (lrc.trim() === '') {
    throw new Error(`refusing to write empty lyrics for song ${id}`);
  }

  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.lyrics.${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, lrc, 'utf-8');
    await rename(tmpPath, songLyricsPath(id));
  } catch (err) {
    await unlink(tmpPath).catch(() => {
      /* best-effort: the write/rename error is the one that matters */
    });
    throw err;
  }
}

/** Delete the lyrics file. `false` = there was nothing to delete. */
export async function deleteLyricsFile(id: string): Promise<boolean> {
  try {
    await unlink(songLyricsPath(id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

// ─── The synced pair (v0.2) ────────────────────────────
//
// Lyrics travel as metadata ops carrying the document itself (D3): there is no
// attachment channel, and an LRC is small. The file is written FIRST and the
// change emitted after — a crash in between loses only the propagation, and
// the next write re-emits, whereas the reverse order would tell the workspace
// about lyrics this device does not have.
//
// The `…File` variants above stay for the apply path: landing a peer's lyrics
// must not emit anything, or two devices would trade the same change forever.

/** Write lyrics and tell the workspace. Local paths only — never apply. */
export async function writeLyrics(db: LarkDatabase, id: string, lrc: string): Promise<void> {
  await writeLyricsFile(id, lrc);
  const sqlite = sqliteOf(db);
  try {
    emitSyncChange(sqlite, {
      entityType: 'song',
      entityId: id,
      op: 'set_lyrics',
      payload: { lrc },
    });
  } catch (err) {
    if (!(err instanceof SyncChangeTooLargeError)) throw err;
    // Explicitly NOT a convergence point (D3/§3.9): the lyrics are correct on
    // this device and will never reach the others. Archived rather than
    // silently dropped, and counted in `/sync/status`.
    recordDeadLetter(sqlite, {
      direction: 'out',
      reason: 'change_too_large',
      entityType: 'song',
      entityId: id,
      op: 'set_lyrics',
      payload: JSON.stringify({ size: Buffer.byteLength(lrc, 'utf8'), limit: err.limit }),
    });
  }
}

/** Delete lyrics and tell the workspace. `false` = there was nothing to delete. */
export async function deleteLyrics(db: LarkDatabase, id: string): Promise<boolean> {
  const deleted = await deleteLyricsFile(id);
  // Emitted even when there was no file: "this song has no lyrics" is the
  // statement, and a peer that still has some must hear it.
  emitSyncChange(sqliteOf(db), {
    entityType: 'song',
    entityId: id,
    op: 'clear_lyrics',
    payload: {},
  });
  return deleted;
}
