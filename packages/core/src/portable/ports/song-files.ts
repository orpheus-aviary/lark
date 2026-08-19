// A song's directory, as the file-effect journal needs it (N2d, decision k).
//
// `FileSystemPort` is file-level on purpose: five calls, each about ONE file,
// with "not there" as a return value. The journal executor needs three things
// it does not cover — remove a whole directory, move one file into
// `recovered-songs/`, move a whole directory there — and they are the only
// operations in core that are about a DIRECTORY rather than a file.
//
// They are a separate port rather than three more methods on `FileSystemPort`
// because the surface a host has to satisfy should say who needs it. Anything
// that reads or writes a library file needs `FileSystemPort`; exactly one
// module needs this, and a host that has not got a journal to drain yet can
// see at a glance which half it is missing.
//
// The vocabulary is `PathsPort`'s, for the same reason: song ids and quarantine
// NAMES, never paths. `join` stays in the adapter, and so does R10 — an id that
// has not passed `assertSongId` must not become a path, and every method here
// takes one.

export interface SongFilesPort {
  /**
   * Does `songs/<id>/` exist?
   *
   * The executor asks before it decides, because a remote delete whose
   * directory is already gone is a rerun after a crash, not a failure.
   */
  songDirExists(songId: string): Promise<boolean>;

  /**
   * Remove `songs/<id>/` and everything in it. Not being there is success.
   *
   * Recursive by contract: what the executor means is "this song's files are
   * gone", and a host that refused a non-empty directory would make the
   * caller enumerate a directory it was told not to reason about.
   */
  removeSongDir(songId: string): Promise<void>;

  /**
   * Does `recovered-songs/<target>/` exist?
   *
   * `quarantine_target` is stable per op, so the answer is evidence: the move
   * already happened and the crash came after it. Which of the two things
   * that means the executor should do is the executor's call, not the host's
   * — that is why this is a question and not a `moveIfAbsent`.
   */
  quarantineExists(target: string): Promise<boolean>;

  /**
   * Move `songs/<id>/<fileName>` to `recovered-songs/<target>/<fileName>`,
   * creating the target directory.
   *
   * Rescue, not deletion: the caller is about to remove the rest of the song
   * directory, and this is what it decided must survive that.
   */
  quarantineSongFile(songId: string, fileName: string, target: string): Promise<void>;

  /**
   * Move all of `songs/<id>/` to `recovered-songs/<target>`.
   *
   * The caller has already established that the target does not exist, so a
   * host may treat an existing one as the error it is rather than merging two
   * directories.
   */
  quarantineSongDir(songId: string, target: string): Promise<void>;
}
