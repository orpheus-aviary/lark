import type {
  ApiResponse,
  CacheEvictResultData,
  CacheStatusData,
  DownloadBatchGroupInput,
  DownloadBatchesData,
  DownloadSongRequest,
  DownloadTaskAcceptedData,
  DownloadTasksData,
  FetchListData,
  FetchListRequest,
  ParseResultData,
  PlayerCommandAcceptedData,
  PlayerCommandBody,
  PlayerCommandName,
  PlayerStatusResponse,
  PlaylistData,
  PlaylistExportData,
  PlaylistImportData,
  PlaylistImportPreviewData,
  PlaylistReorderRequest,
  PlaylistSongsAddedData,
  RecognizeUrlData,
  SongData,
  SongSortField,
  SortOrder,
  StatusData,
  SyncFileOpRunData,
  SyncFileOpState,
  SyncFileOpsData,
  SyncLoginRequest,
  SyncLoginResultData,
  SyncLogoutResultData,
  SyncRunResultData,
  SyncStatusData,
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

  // ── Download (M6-11) ───────────────────────────────
  //
  // Daemon-only, all of them: the queue, the claims and the network client
  // live there, and a second downloader in a CLI process would be a second
  // writer to the same files. The direct backend answers `USAGE_ERROR`, and
  // the mode matrix refuses `--direct` before it ever gets that far.
  /** Preview: classifies what was pasted and enqueues nothing. */
  parseInput(input: string): Promise<ApiResponse<ParseResultData>>;
  downloadSong(request: DownloadSongRequest): Promise<ApiResponse<DownloadTaskAcceptedData>>;
  /** Expand a favourites folder / collection into videos. Partial success is normal. */
  fetchList(request: FetchListRequest): Promise<ApiResponse<FetchListData>>;
  downloadBatch(
    groups: readonly DownloadBatchGroupInput[],
  ): Promise<ApiResponse<DownloadBatchesData>>;
  /** The whole queue snapshot — what `--wait` polls. */
  downloadTasks(): Promise<ApiResponse<DownloadTasksData>>;
  redownloadSong(id: string): Promise<ApiResponse<DownloadTaskAcceptedData>>;

  // ── Player (M6-7) ──────────────────────────────────
  //
  // Playback happens in the GUI; the daemon is the only thing that can reach
  // it (one SSE channel, one active consumer), and a command's answer is the
  // GUI's ack — which is why these are daemon-only too.
  playerStatus(): Promise<ApiResponse<PlayerStatusResponse>>;
  playerCommand<C extends PlayerCommandName>(
    command: C,
    body: PlayerCommandBody<C>,
  ): Promise<ApiResponse<PlayerCommandAcceptedData>>;

  // ── Source url (M6-12) ─────────────────────────────
  /** Preview what a URL resolves to. Writes nothing (R6). */
  recognizeUrl(id: string, url?: string): Promise<ApiResponse<RecognizeUrlData>>;

  // ── Lyrics ─────────────────────────────────────────
  downloadLyrics(id: string): Promise<ApiResponse<DownloadTaskAcceptedData>>;
  deleteLyrics(id: string): Promise<ApiResponse<{ id: string }>>;

  // ── Transfer (M6-13) ───────────────────────────────
  exportPlaylist(id: string): Promise<ApiResponse<PlaylistExportData>>;
  importPreview(filePath: string): Promise<ApiResponse<PlaylistImportPreviewData>>;
  importPlaylist(request: ImportCommitRequest): Promise<ApiResponse<PlaylistImportData>>;

  // ── Sync (v0.2 T5) ─────────────────────────────────
  //
  // The split here runs the other way from every family above: these six are
  // DAEMON-ONLY (the session, the refresh timer and the round coalescer live
  // there, and a second syncer in a CLI process would push the same changes
  // twice), while `syncUnbind` is DIRECT-ONLY — it clears the outbox and the
  // tombstones with the library to itself, which is exactly what a running
  // daemon rules out. Each backend answers `USAGE_ERROR` for the other half.
  syncStatus(): Promise<ApiResponse<SyncStatusData>>;
  syncLogin(body: SyncLoginRequest): Promise<ApiResponse<SyncLoginResultData>>;
  syncLogout(): Promise<ApiResponse<SyncLogoutResultData>>;
  syncRun(): Promise<ApiResponse<SyncRunResultData>>;
  syncFileOps(state?: SyncFileOpState): Promise<ApiResponse<SyncFileOpsData>>;
  syncFileOpsRetry(id?: number): Promise<ApiResponse<SyncFileOpRunData>>;
  syncFileOpsDiscard(id: number): Promise<ApiResponse<{ id: number }>>;
  /**
   * What an unbind would throw away. Read directly, like unbind itself: the
   * confirmation has to name the number BEFORE the user answers (R5-P1-3).
   */
  syncPendingChanges(): Promise<ApiResponse<SyncPendingChangesData>>;
  /** Detach this library from its workspace. Never crosses a daemon (§3.7). */
  syncUnbind(options: { force: boolean }): Promise<ApiResponse<SyncUnbindData>>;
}

/**
 * What an unbind gave up, as the command prints it.
 *
 * CLI-local rather than a shared wire type on purpose: unbind has no daemon
 * route to carry it, and putting it in `@lark/shared` would suggest one exists.
 */
export interface SyncPendingChangesData {
  total: number;
  /** Deletions and lyric clears — the ones a backfill can never bring back. */
  unpublished_deletes: number;
}

export interface SyncUnbindData {
  changes: number;
  tombstones: number;
  dead_letters: number;
  cursors: number;
  /** Non-zero only under `--force`: what can never be republished. */
  discarded_changes: number;
  discarded_deletes: number;
  had_credentials: boolean;
  backfill_target: number;
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
