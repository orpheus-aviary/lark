// Getting a playlist file off the phone and into the app (N6a).
//
// The mirror of `playlist-export.ts`, and the asymmetry is worth naming: an
// export is a file we own being handed OUT through the share sheet, so it goes
// to the cache directory and stops mattering the moment the sheet closes. An
// import is a file we do not own being read IN, and the system never hands it
// over — it hands over a `content://` URI plus permission to read it, for as
// long as this activity lives.
//
// NO NEW DEPENDENCY, which is a correction to the subplan's §1.4: it named
// `expo-document-picker`, and `expo-file-system@57` turns out to carry
// `File.pickFileAsync` itself. One package doing both halves of this file is
// also one package deciding what a URI means.
//
// The grant is why `read()` is a function rather than bytes taken once: the
// two-phase import re-reads (`library/import.ts`), and a URI that has gone
// stale must fail there rather than be papered over with a copy this file made
// behind everybody's back.

import { File, Paths } from 'expo-file-system';
import type { ImportFileSource } from '../library/import';

/**
 * Ask for a file. `null` is a cancelled picker — an answer, not a failure.
 *
 * A WILDCARD mime type rather than `application/json`: the file managers on
 * this device hide anything they do not recognise, and a
 * `.lark-playlist.json` written by the desktop and moved through a chat app
 * arrives with whatever type that app decided on. Core's parser is the thing
 * that says whether a file is one of ours, and it says so in a sentence
 * (`library/import.ts`).
 */
export async function pickPlaylistFile(): Promise<ImportFileSource | null> {
  const picked = await File.pickFileAsync({ mimeTypes: ['*/*'] });
  if (picked.canceled) return null;

  const file = picked.result;
  return {
    // A SAF URI's last segment can be a document id rather than a filename, so
    // this is "what to show", not "what it is called". Nothing depends on it.
    name: Paths.basename(file),
    // 0 when the provider will not stat it — `ImportFileSource.size` documents
    // what that means, and it does NOT mean an empty file.
    size: file.size,
    read: () => file.bytes(),
  };
}
