import type {
  ApiResponse,
  CacheEvictResultData,
  CacheStatusData,
  PlaylistData,
  PlaylistExportData,
  PlaylistImportData,
  PlaylistImportPreviewData,
  PlaylistReorderRequest,
  PlaylistSongsAddedData,
  SongData,
  SongSortField,
  SortOrder,
  StatusData,
  UpdateSongRequest,
} from '@lark/shared';

/** `GET /songs` query, already validated by the command layer. */
export interface SongListQuery {
  search?: string;
  sort?: SongSortField;
  order?: SortOrder;
  limit?: number;
  offset?: number;
}

/**
 * What a command may call, independent of how it reaches the data.
 *
 * Two backends implement it: HTTP (the default, talking to a running daemon)
 * and `--direct` (linking `@lark/core` in-process, from T3). The mode matrix in
 * `resolve.ts` decides which one a given command gets, and R31 is the rule that
 * shapes it: while OUR daemon is alive, a direct WRITE is refused outright,
 * because cross-process mutual exclusion for playback / downloads / cache
 * eviction lives in the daemon and nowhere else.
 *
 * Commands receive the raw envelope, never a plucked-out payload, so `--json`
 * can print exactly what the daemon said — `message` and `total` included.
 *
 * The interface grows one batch at a time, alongside the commands that need
 * it; the direct backend answers anything it does not implement with
 * `USAGE_ERROR` rather than a half-working approximation (M6-5).
 */
export interface Backend {
  status(): Promise<ApiResponse<StatusData>>;

  // ── Songs ──────────────────────────────────────────
  listSongs(query: SongListQuery): Promise<ApiResponse<SongData[]>>;
  getSong(id: string): Promise<ApiResponse<SongData>>;
  updateSong(id: string, patch: UpdateSongRequest): Promise<ApiResponse<SongData>>;
  deleteSong(id: string): Promise<ApiResponse<{ id: string }>>;
  pinSong(id: string, pinned: boolean): Promise<ApiResponse<SongData>>;

  // ── Playlists ──────────────────────────────────────
  listPlaylists(): Promise<ApiResponse<PlaylistData[]>>;
  createPlaylist(name: string): Promise<ApiResponse<PlaylistData>>;
  renamePlaylist(id: string, name: string): Promise<ApiResponse<PlaylistData>>;
  deletePlaylist(id: string): Promise<ApiResponse<{ id: string }>>;
  listPlaylistSongs(id: string): Promise<ApiResponse<SongData[]>>;
  addPlaylistSongs(
    id: string,
    songIds: readonly string[],
  ): Promise<ApiResponse<PlaylistSongsAddedData>>;
  removePlaylistSong(
    id: string,
    songId: string,
  ): Promise<ApiResponse<{ playlist_id: string; song_id: string }>>;
  reorderPlaylist(
    id: string,
    move: PlaylistReorderRequest,
  ): Promise<ApiResponse<{ playlist_id: string }>>;

  // ── Cache (M6-4) ───────────────────────────────────
  cacheStatus(): Promise<ApiResponse<CacheStatusData>>;
  /** Runs the LRU drain. Direct mode holds the writer lock for the whole run. */
  cacheEvict(): Promise<ApiResponse<CacheEvictResultData>>;

  // ── Transfer (M6-13) ───────────────────────────────
  exportPlaylist(id: string): Promise<ApiResponse<PlaylistExportData>>;
  importPreview(filePath: string): Promise<ApiResponse<PlaylistImportPreviewData>>;
  importPlaylist(request: ImportCommitRequest): Promise<ApiResponse<PlaylistImportData>>;
}

/** `POST /playlists/import` body, as the command layer assembles it. */
export interface ImportCommitRequest {
  file_path: string;
  digest: string;
  target:
    | { kind: 'all' }
    | { kind: 'playlist'; playlist_id: string }
    | { kind: 'new'; name: string };
  reuse?: readonly { index: number; song_id: string }[];
}
