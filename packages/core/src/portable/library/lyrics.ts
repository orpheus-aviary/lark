// Lyrics on disk, and the pair of writes that publish them (M2 T6).
//
// Paths are never assembled here and never by a caller: they come from the
// `PathsPort`, which runs the UUID gate before any join (R10) — `songs/<id>/`
// is a real filesystem location, and an id that reaches a join unvalidated is
// a traversal waiting to happen.
//
// Lyrics live beside the audio as `lyrics.lrc` but are NOT audio: they are
// tiny, they cannot be re-derived from a source key, and they never
// participate in cache eviction (R1/R26). Deleting one is an explicit user
// action, which is why `deleteLyrics` exists and no "delete the song's files"
// helper does. M3's lyrics download writes through this same module.
//
// The filesystem arrives as a `FileContext` parameter (N1c) rather than as
// imports: this module is one of the ones that has to run on a phone, and
// "which filesystem" is the caller's answer, not this file's.

import type { PortableDb } from '../db.js';
import { SyncChangeTooLargeError } from '../errors.js';
import type { FileContext } from '../ports/fs.js';
import { utf8ByteLength } from '../runtime/text.js';
import { emitSyncChange, recordDeadLetter } from '../sync/changes.js';

export { CANONICAL_AUDIO_FILE, LEGACY_AUDIO_FILE } from '../ports/paths.js';

/** LRC text, or `null` when the song has no lyrics file. */
export async function readLyrics(files: FileContext, id: string): Promise<string | null> {
  return files.fs.readText(files.paths.songLyrics(id));
}

/**
 * Write (or replace) the lyrics file atomically (R22).
 *
 * The atomicity is the port's contract — temp sibling then rename, so a crash
 * mid-write can never leave a half-file where working lyrics were. This is the
 * one document in the library that cannot be downloaded again, and the local
 * write path is direct rather than journalled, so there is no second mechanism
 * underneath to repair it.
 *
 * Empty content is refused. "No lyrics" is the absence of the file, which is
 * what `readLyrics` reports as `null`; a zero-byte file would read as lyrics
 * that exist and say nothing.
 */
export async function writeLyricsFile(files: FileContext, id: string, lrc: string): Promise<void> {
  const path = files.paths.songLyrics(id); // validates the id before any path is built
  if (lrc.trim() === '') {
    throw new Error(`refusing to write empty lyrics for song ${id}`);
  }
  await files.fs.writeTextAtomic(path, lrc);
}

/** Delete the lyrics file. `false` = there was nothing to delete. */
export async function deleteLyricsFile(files: FileContext, id: string): Promise<boolean> {
  return files.fs.unlink(files.paths.songLyrics(id));
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
export async function writeLyrics(
  store: PortableDb,
  files: FileContext,
  id: string,
  lrc: string,
): Promise<void> {
  await writeLyricsFile(files, id, lrc);
  const { sqlite } = store;
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
export async function deleteLyrics(
  store: PortableDb,
  files: FileContext,
  id: string,
): Promise<boolean> {
  const deleted = await deleteLyricsFile(files, id);
  // Emitted even when there was no file: "this song has no lyrics" is the
  // statement, and a peer that still has some must hear it.
  emitSyncChange(store.sqlite, {
    entityType: 'song',
    entityId: id,
    op: 'clear_lyrics',
    payload: {},
  });
  return deleted;
}
