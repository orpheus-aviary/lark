// The LibraryContract's vocabulary (N1g, decision k — shaped like the
// DatabaseContract).
//
// One suite of cases, run through every path a front end can take to the
// library: the daemon's HTTP routes, the CLI's in-process `--direct` backend,
// and in N2 a mobile client. The point is not that all three "have a library"
// — it is that they make the same decisions about it, which is precisely what
// they stopped doing when each of them wrote those decisions out separately
// (§7 F13, and the two M6 cases).
//
// A case asserts what the LIBRARY answers, never what a front end calls it.
// The daemon says `INVALID_BODY` where the CLI says `USAGE_ERROR`, and both
// are right: a wire and a terminal owe their callers different words. Each
// hook therefore translates its own dialect into the small vocabulary below,
// and the cases speak only that.

import type { PlaylistData, PlaylistExportData, SongData } from '@lark/shared';

/** What the library refused, independent of what any front end calls it. */
export type ContractFailure =
  /** A library input rule: blank after trimming, over a cap, too many ids. */
  | 'invalid-input'
  /** Not a UUID v4 (R10). */
  | 'invalid-id'
  /** A write aimed at the virtual `all` view (R3/R24). */
  | 'virtual-playlist'
  | 'not-found'
  /** Anything the hook could not place — always a case failure, never a pass. */
  | 'other';

export interface ContractSongSeed {
  name: string;
  artist?: string;
  source_provider?: string;
  source_key?: string;
  /** Write an audio file of this many bytes, so `has_file` has something to find. */
  fileBytes?: number;
}

export interface ContractSongQuery {
  search?: string;
  /**
   * The three sorts every front end offers.
   *
   * core knows two more (`updated_at`, `last_accessed_at`) and the daemon
   * accepts them; the CLI's `--sort` never offered them. That is a front end
   * choosing what to expose, not a disagreement about the library, so the
   * contract asks only for what all of them have.
   */
  sort?: 'name' | 'artist' | 'created_at';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface ContractReorderMove {
  song_id: string;
  before_song_id?: string;
  after_song_id?: string;
}

/**
 * The library, as one front end reaches it.
 *
 * Everything is async because one of the hooks goes over the wire. Failures
 * arrive as a thrown {@link ContractRefusal}, so a case can say "this must be
 * refused, and for this reason" without knowing whose error class it is.
 */
export interface LibrarySubject {
  listSongs(query: ContractSongQuery): Promise<{ songs: SongData[]; total: number }>;
  getSong(id: string): Promise<SongData>;
  updateSong(id: string, patch: { name?: string; artist?: string }): Promise<SongData>;
  deleteSong(id: string): Promise<void>;
  pinSong(id: string, pinned: boolean): Promise<SongData>;

  listPlaylists(): Promise<PlaylistData[]>;
  createPlaylist(name: string): Promise<PlaylistData>;
  renamePlaylist(id: string, name: string): Promise<PlaylistData>;
  deletePlaylist(id: string): Promise<void>;
  listPlaylistSongs(id: string): Promise<SongData[]>;
  addPlaylistSongs(id: string, songIds: readonly string[]): Promise<number>;
  removePlaylistSong(id: string, songId: string): Promise<void>;
  reorderPlaylist(id: string, move: ContractReorderMove): Promise<void>;

  exportPlaylist(id: string): Promise<PlaylistExportData>;
  /** Bytes the cache considers reclaimable, as this front end reports them. */
  cacheUsedBytes(): Promise<number>;

  // ── outside the surface, because the cases need a library to talk about ──

  /** Put a song in the library WITHOUT going through the surface. */
  seedSong(seed: ContractSongSeed): Promise<string>;
  /** Is this song's directory still on disk? (a delete queues its removal) */
  songFilesExist(id: string): Promise<boolean>;
}

/** Thrown by a subject when the library refused. Hooks build it; cases read it. */
export class ContractRefusal extends Error {
  readonly failure: ContractFailure;
  /** What the front end actually called it, for a failure message worth reading. */
  readonly nativeCode: string;
  constructor(failure: ContractFailure, nativeCode: string) {
    super(`library refused: ${failure} (${nativeCode})`);
    this.name = 'ContractRefusal';
    this.failure = failure;
    this.nativeCode = nativeCode;
  }
}

export interface LibraryContractHooks {
  /** A fresh, EMPTY library reachable through this front end. */
  open(): Promise<LibrarySubject>;
  /** Release it. Called once per case, including after a failure. */
  close(subject: LibrarySubject): Promise<void>;
}

export interface LibraryContractCase {
  readonly group: string;
  readonly name: string;
  /** Throws to fail. Gets a library fresh from the hook. */
  run(subject: LibrarySubject): Promise<void>;
}
