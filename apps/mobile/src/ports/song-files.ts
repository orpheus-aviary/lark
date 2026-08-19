// `SongFilesPort` over expo-file-system (N2d, decision k).
//
// The five directory-level verbs the journal executor needs. Everything it
// DECIDES — which of the four op kinds, what a remote delete keeps, what an
// existing quarantine target means — is in `@lark/core/portable`; this file
// only knows how to move things on this phone.
//
// Two of expo's semantics are load bearing here, both read out of
// `fsops/CopyMoveStrategy.kt` rather than guessed at:
//
//   File → Directory requires the destination directory to EXIST
//   (`prepareAsDestination` throws `DestinationDoesNotExistException`), so the
//   quarantine target is created before the move.
//
//   Directory → Directory branches on whether the destination exists: absent,
//   the source BECOMES it (parent must exist); present, the source is nested
//   INSIDE it. The executor only ever asks for the first, so the second is
//   turned into a loud error rather than a quiet wrong shape.

import type { SongFilesPort } from '@lark/core/portable';
import { File } from 'expo-file-system';
import { recoveredSongsDirectory, recoveredSongsRoot, songDirectory } from './paths';

export function createSongFiles(): SongFilesPort {
  return {
    async songDirExists(songId: string): Promise<boolean> {
      return songDirectory(songId).exists;
    },

    async removeSongDir(songId: string): Promise<void> {
      const directory = songDirectory(songId);
      // `delete()` is recursive (`FileSystemPath.kt` → `deleteRecursively`)
      // but throws on a missing directory, and the port says absence is
      // success — a rerun after a crash must find nothing to do.
      if (directory.exists) directory.delete();
    },

    async quarantineExists(target: string): Promise<boolean> {
      return recoveredSongsDirectory(target).exists;
    },

    async quarantineSongFile(songId: string, fileName: string, target: string): Promise<void> {
      const destination = recoveredSongsDirectory(target);
      if (!destination.exists) destination.create({ intermediates: true });
      await new File(songDirectory(songId), fileName).move(destination);
    },

    async quarantineSongDir(songId: string, target: string): Promise<void> {
      const destination = recoveredSongsDirectory(target);
      if (destination.exists) {
        // Expo would nest the song directory inside it and report success.
        // The caller has already established this cannot happen, so if it did,
        // something upstream is wrong and hiding it costs the user a directory
        // they will never find.
        throw new Error(`quarantine target '${target}' already exists`);
      }
      const root = recoveredSongsRoot();
      if (!root.exists) root.create({ intermediates: true });
      await songDirectory(songId).move(destination);
    },
  };
}
