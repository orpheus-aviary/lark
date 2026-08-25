// Handing a playlist to another app (N4g-2, criterion 39, decision f).
//
// The desktop writes the file wherever a save dialog says; Android has no save
// dialog worth the name and no shared filesystem to point one at, so the phone
// does what a phone does: write a file the app owns and pass a grant to it
// through the system share sheet. `expo-sharing` publishes it through its own
// FileProvider, whose `sharing_provider_paths.xml` covers exactly three roots
// — external, files, cache — which is why the file goes to the CACHE one.
//
// THE FILE IS RUBBISH THE MOMENT THE SHEET CLOSES. It exists so an intent can
// carry it, and Android empties the cache directory whenever it likes. What is
// NOT rubbish is the JSON: byte for byte the same document the desktop writes
// (`buildExport`, two-space indent, no trailing newline — `TopBar.tsx`), so a
// file exported here imports there. `exported_at` is `Date.now()` in both, so
// two exports of one playlist are equal in structure and never in bytes
// (§1.6).
//
// NOT SAF (主计划 §4.5): a document picker would let somebody pick a folder in
// their file manager, and that is a whole permission story bought for a file
// they are about to send to themselves.

import type { LibraryService } from '@lark/core/portable';
import { VIRTUAL_ALL_PLAYLIST_ID, sanitizeFileName } from '@lark/shared';
import type { PlaylistExportData } from '@lark/shared';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/** The desktop's default name, to the letter (`TopBar.tsx`, `transfer.ts`). */
function exportFileName(playlistName: string): string {
  return `${sanitizeFileName(playlistName)}.lark-playlist.json`;
}

/**
 * Write the export and open the share sheet on it.
 *
 * Resolves when the sheet closes — `shareAsync` cannot tell whether anything
 * was actually sent, and does not pretend to. It THROWS when the export or the
 * write fails, and the caller says so; a system with nothing to share to is
 * the one case that answers rather than throws, because "this device cannot"
 * is not a failure of ours.
 */
export async function sharePlaylistExport(
  library: LibraryService,
  playlist: { id: string; name: string },
): Promise<{ shared: boolean; songCount: number }> {
  return share(library.buildExport({ playlistId: playlist.id }), `导出「${playlist.name}」`);
}

/**
 * The whole library, through the same virtual `all` the desktop exports
 * (N6c, criterion 102).
 *
 * 🔴 IT IS THE ONLY BACKUP A PHONE HAS. Playlist export alone left a hole
 * nobody would notice until it mattered: a song in no playlist could not be
 * exported at all, while the settings screen was busy telling people that
 * exporting is how you survive an uninstall. The desktop has had this since
 * M5 (`TopBar.tsx`: *"Export works on `all` too — it is the whole library"*);
 * the phone dropped the virtual `all` from its playlist list for good reasons
 * (2026-08-24) and lost the export with it.
 *
 * `name: VIRTUAL_ALL_PLAYLIST_ID` — the literal string `all` — because that is
 * what the daemon passes (`routes/playlists.ts:211`) and the file has to be
 * the desktop's byte for byte. So the file is `all.lark-playlist.json` and
 * importing it proposes a playlist called `all`; the import screen's name
 * field is editable, which is where that gets fixed.
 */
export async function shareLibraryExport(
  library: LibraryService,
): Promise<{ shared: boolean; songCount: number }> {
  return share(
    library.buildExport({ playlistId: null, name: VIRTUAL_ALL_PLAYLIST_ID }),
    '导出整个曲库',
  );
}

async function share(
  data: PlaylistExportData,
  dialogTitle: string,
): Promise<{ shared: boolean; songCount: number }> {
  if (!(await Sharing.isAvailableAsync())) {
    return { shared: false, songCount: data.songs.length };
  }

  const file = new File(Paths.cache, exportFileName(data.playlist.name));
  // Overwrite rather than uniquify: exporting the same playlist twice should
  // leave one file behind, not two.
  file.create({ overwrite: true });
  file.write(JSON.stringify(data, null, 2));

  await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle });
  return { shared: true, songCount: data.songs.length };
}
