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
import { InvalidIdError } from '../errors.js';
import { songsDir } from '../paths.js';

/** `songs/<id>/` — throws InvalidIdError before touching the filesystem. */
export function songDirPath(id: string): string {
  if (!isUuidV4(id)) throw new InvalidIdError(id);
  return join(songsDir(), id);
}

/** `songs/<id>/song.mp3` */
export function songAudioPath(id: string): string {
  return join(songDirPath(id), 'song.mp3');
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
export async function writeLyrics(id: string, lrc: string): Promise<void> {
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
export async function deleteLyrics(id: string): Promise<boolean> {
  try {
    await unlink(songLyricsPath(id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
