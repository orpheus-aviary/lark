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

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type LarkDatabase, sqliteOf } from '../db/index.js';
import { SyncChangeTooLargeError } from '../errors.js';
import { nodePaths } from '../paths.js';
import { uuid } from '../portable/runtime/random.js';
import { utf8ByteLength } from '../portable/runtime/text.js';
import { emitSyncChange, recordDeadLetter } from '../sync/changes.js';

// One implementation of "where is this song's audio", in `paths.ts`, behind
// the `PathsPort` interface a phone will implement too (N1a). These stay
// exported under the names the rest of core already imports.
const nodeSongPaths = nodePaths();

export { CANONICAL_AUDIO_FILE, LEGACY_AUDIO_FILE } from '../paths.js';

/** `songs/<id>/` — throws InvalidIdError before touching the filesystem. */
export function songDirPath(id: string): string {
  return nodeSongPaths.songDir(id);
}

/** `songs/<id>/song.m4a` */
export function songAudioPath(id: string): string {
  return nodeSongPaths.songAudio(id);
}

/** `songs/<id>/lyrics.lrc` */
export function songLyricsPath(id: string): string {
  return nodeSongPaths.songLyrics(id);
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
  const tmpPath = join(dir, `.lyrics.${uuid()}.tmp`);
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
      payload: JSON.stringify({ size: utf8ByteLength(lrc), limit: err.limit }),
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
