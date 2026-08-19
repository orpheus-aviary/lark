// The daemon's view of the library service (N1g).
//
// Built per call, which costs a few closures: every field is a live handle off
// the context, and a service captured at route-registration time would be
// holding a runtime that does not exist yet (routes register before
// activation, §3.2-3).
//
// `audioMode` is always `canonical` here, and that is a statement about the
// daemon rather than a shortcut: business routes do not serve while the mp3 →
// m4a conversion is pending, so the daemon never reads a library that still
// holds an mp3. The CLI's direct backend is the one that has to look.

import { type FileEffectLike, type LibraryService, createLibraryService } from '@lark/core';
import type { AppContext } from './context.js';

export interface LibraryServiceOptions {
  /**
   * The runtime that executes a delete's file removal.
   *
   * `DELETE /songs/:id` passes one of its OWN, because it is holding that
   * song's exclusive claim and the shared registry would refuse the drain its
   * own caller is waiting for.
   */
  fileOps?: FileEffectLike;
}

export function libraryService(
  ctx: AppContext,
  options: LibraryServiceOptions = {},
): LibraryService {
  return createLibraryService({
    db: ctx.portable,
    files: ctx.files,
    fileOps: options.fileOps ?? ctx.fileOps,
    audioMode: 'canonical',
  });
}
