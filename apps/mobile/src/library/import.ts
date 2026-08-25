// Getting a playlist file as far as "core has parsed it" (N6a).
//
// The desktop hands the daemon a PATH and the daemon reads it — twice, once
// per phase (`routes/playlists.ts`). A phone has no daemon and no path it may
// read freely, so the app reads the bytes itself and core only ever sees
// bytes. What must survive that difference is the part the two phases rest on:
// BOTH of them read the file, and the digest is what keeps the answer given in
// phase one meaningful in phase two (`ImportPlaylistDialog.tsx`'s header).
//
// `ImportFileSource` is the reason this file imports nothing native and can
// therefore be tested at all. The picker, the `content://` URI and `bytes()`
// live in `services/playlist-import.ts`; what stays here is the size gate and
// the call order — the two things that are wrong silently.

import type { LibraryService, ParsedImportFile } from '@lark/core/portable';

/** The daemon route's cap, to the byte (M5-13, `IMPORT_FILE_MAX_BYTES`). */
export const IMPORT_FILE_MAX_BYTES = 20 * 1024 * 1024;

export interface ImportFileSource {
  /** What to call it on screen. */
  readonly name: string;
  /**
   * The size the system declared, or `0` when it declined to.
   *
   * `expo-file-system` reports 0 for a file it cannot stat, and a SAF
   * `content://` URI is exactly that kind of file — so 0 means "you will have
   * to read it to find out", never "this file is empty".
   */
  readonly size: number;
  /** Read the whole file. Called ONCE PER PHASE: preview, then commit. */
  read(): Promise<Uint8Array>;
}

const MAX_MB = IMPORT_FILE_MAX_BYTES / 1024 / 1024;

function tooLarge(name: string, bytes: number): Error {
  return new Error(`「${name}」有 ${(bytes / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_MB}MB`);
}

/**
 * Bytes → a parsed, digested file — or a refusal.
 *
 * The cap is checked TWICE, and the first check is the one that matters: a
 * declared size is what stops a 300MB video from being pulled into JS at all.
 * The second exists because the declaration is optional, and a system that
 * declined to say has said nothing about how big the file is.
 */
export async function loadImportFile(
  library: Pick<LibraryService, 'parseImportFile'>,
  source: ImportFileSource,
): Promise<ParsedImportFile> {
  if (source.size > IMPORT_FILE_MAX_BYTES) throw tooLarge(source.name, source.size);
  const bytes = await source.read();
  if (bytes.length > IMPORT_FILE_MAX_BYTES) throw tooLarge(source.name, bytes.length);
  return library.parseImportFile(bytes);
}
