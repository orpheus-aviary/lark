// The `--direct` backend (M6-5, §4.1): the same commands, served by opening
// the library in this process instead of asking a daemon.
//
// Two shapes, because they have different rights:
//
//   READ  opens the library READ-ONLY and takes no lock at all. Safe next to
//         anything — a daemon, a backup, a migration — because it writes
//         nothing (M6-20).
//   WRITE takes the cross-process WRITER LOCK for the whole command and opens
//         the library normally. R31 already guarantees no daemon is running;
//         the lock is what excludes the OTHER three writers (M6-18).
//
// `@lark/core` is imported DYNAMICALLY, right here and nowhere else: the
// barrel loads better-sqlite3, and `lark status --json` must not fail on a
// native module built for the other runtime when it never intended to open a
// database (M6-21).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { probeNativeAbi } from '@lark/core/native-probe';
import { VIRTUAL_ALL_PLAYLIST_ID, isUuidV4 } from '@lark/shared';
import type { ApiResponse, PlaylistData, SongData } from '@lark/shared';
import { CliError, usageError } from '../lib/errors.js';
import { abiError } from '../lib/native-abi.js';
import { toDirectCliError } from './direct-errors.js';
import type { Backend, ImportCommitRequest, SongListQuery } from './types.js';

type Core = typeof import('@lark/core');

/** Input caps, copied from the daemon's route contract so both agree (§4.1). */
const NAME_MAX = 500;
const SEARCH_MAX = 200;
const LIMIT_MAX = 1000;
const SONG_IDS_MAX = 1000;

export interface DirectBackend {
  backend: Backend;
  /** Close the database and release the writer lock. Idempotent. */
  close(): void;
}

export interface DirectBackendOptions {
  mode: 'read' | 'write';
  /** Overrides for tests; production always uses the real nest. */
  dbPath?: string;
  /** Test seam: the ABI pre-check (M7-14). */
  probeAbi?: typeof probeNativeAbi;
}

/**
 * Open the library and build a Backend over it.
 *
 * Throws the same `CliError`s a command would get from the HTTP backend: an
 * uninitialised library is `DB_NOT_INITIALIZED`, a busy writer is
 * `WRITER_BUSY`, a Go-era library is `MIGRATION_REQUIRED`.
 */
export async function createDirectBackend(options: DirectBackendOptions): Promise<DirectBackend> {
  // Probed BEFORE the barrel is imported (M7-14). Without this the failure is
  // whatever dlopen said, wrapped as `UNKNOWN` and exit 1 — a message about
  // NODE_MODULE_VERSION with no hint that it is repairable, and an exit code
  // that says "the operation failed" rather than "this environment cannot".
  const abi = await (options.probeAbi ?? probeNativeAbi)();
  if (!abi.ok) throw abiError(abi);

  const core: Core = await import('@lark/core');
  const dbPath = options.dbPath ?? core.paths.dbPath();

  return options.mode === 'read' ? openForRead(core, dbPath) : openForWrite(core, dbPath);
}

function openForRead(core: Core, dbPath: string): DirectBackend {
  const handles = attempt(() => core.openDatabaseReadonly({ dbPath }));
  let closed = false;
  return {
    backend: buildBackend(core, handles, 'read'),
    close() {
      if (closed) return;
      closed = true;
      handles.sqlite.close();
    },
  };
}

function openForWrite(core: Core, dbPath: string): DirectBackend {
  // A write may be the FIRST thing that ever happens in this nest, and the
  // lock database cannot be created in a directory that does not exist. The
  // frozen order for a direct write is mkdir → lock → open (M6-18 ②); the read
  // path deliberately does none of this and answers `DB_NOT_INITIALIZED`.
  mkdirSync(dirname(dbPath), { recursive: true });

  // The lock comes FIRST: `createDatabase` runs crash recovery and forward
  // migrations, which are writes like any other.
  const lock = attempt(() => core.acquireWriterLock({ dbPath }));
  let handles: Handles;
  try {
    handles = attempt(() => core.createDatabase({ dbPath }));
    // A library that still owes the mp3 → m4a conversion is not writable by
    // anything but the migration (§3.2-12). `createDatabase` may have just
    // CREATED that state — a v2 library upgrades here — so the check belongs
    // after it, not before. A brand-new library never trips it: the same call
    // clears the flag for a library it built from nothing.
    if (core.isAudioMigrationPending(handles.sqlite)) {
      handles.sqlite.close();
      throw new CliError(
        'AUDIO_MIGRATION_PENDING',
        '这个曲库还欠一次性的 mp3 → m4a 转换。先启动一次 lark（GUI 或 `lark daemon`）让它跑完，再用 --direct 写。',
      );
    }
  } catch (err) {
    lock.release();
    throw err;
  }

  let closed = false;
  return {
    backend: buildBackend(core, handles, 'write'),
    close() {
      if (closed) return;
      closed = true;
      // Database first, lock second — the lock says "this library has a
      // writer", and that stays true until the last connection is gone.
      handles.sqlite.close();
      lock.release();
    },
  };
}

/** Run a core call, translating whatever it throws (§4.1). */
function attempt<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw toDirectCliError(err);
  }
}

async function attemptAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toDirectCliError(err);
  }
}

type Handles = ReturnType<Core['createDatabase']>;

function buildBackend(core: Core, handles: Handles, mode: 'read' | 'write'): Backend {
  const { db, sqlite } = handles;

  /** `has_file` / `file_size` are a live disk probe, exactly as the daemon does. */
  //
  // Which NAME counts as the file comes from the library's own migration flag
  // (§3.2-12). A direct READ is allowed while the conversion is still running
  // — reads take no lock — and a song waiting its turn still has its audio, as
  // an mp3. Reporting it as missing would tell the user to download something
  // they already have.
  //
  // Read once, at open: the mode only ever WIDENS what counts (m4a, or m4a and
  // mp3), so a pass finishing mid-command cannot make this answer wrong.
  const audioMode = core.isAudioMigrationPending(sqlite) ? 'migration-pending' : 'canonical';
  const enrich = (song: SongData): SongData => ({
    ...song,
    ...core.songFileInfo(song.id, { audioMode }),
  });

  const ok = <T>(data: T, extra: { message?: string; total?: number } = {}): ApiResponse<T> => {
    const envelope: ApiResponse<T> = { success: true, data };
    if (extra.message !== undefined) envelope.message = extra.message;
    if (extra.total !== undefined) envelope.total = extra.total;
    return envelope;
  };

  /** A write reached a read-only backend: a bug, not a user error. */
  const writable = (): void => {
    if (mode !== 'write') {
      throw new CliError('USAGE_ERROR', '这个操作需要写权限，但当前是只读直连模式。');
    }
  };

  /**
   * The id gate the daemon's route layer applies before core sees anything
   * (§4.1). Core would eventually notice too, but it reports "not found" —
   * and a malformed id is a USAGE problem, not a missing row.
   */
  const validId = (id: string): string => {
    if (!isUuidV4(id)) throw new CliError('INVALID_ID', `不是合法的 id：${JSON.stringify(id)}`);
    return id;
  };

  /** Readable ids also accept the virtual `all` (R3/R24). */
  const readableId = (id: string): string => (id === VIRTUAL_ALL_PLAYLIST_ID ? id : validId(id));

  /** `all` is a view: readable, never writable. */
  const writablePlaylistId = (id: string): string => {
    if (id === VIRTUAL_ALL_PLAYLIST_ID) {
      throw new CliError('VIRTUAL_PLAYLIST', '「all」是虚拟歌单，不能写入。');
    }
    return validId(id);
  };

  const capped = (value: string, max: number, what: string): string => {
    if (value.length > max) throw usageError(`${what}最长 ${max} 个字符。`);
    return value;
  };

  return {
    status: () =>
      Promise.reject(new CliError('USAGE_ERROR', '`status` 只描述 daemon，不走直连后端。')),

    // ── Songs ──────────────────────────────────────────
    listSongs: (query: SongListQuery) => {
      const options: SongListQuery = { ...query };
      if (options.search !== undefined)
        options.search = capped(options.search, SEARCH_MAX, '搜索词');
      if (options.limit !== undefined && options.limit > LIMIT_MAX) {
        throw usageError(`--limit 最大 ${LIMIT_MAX}。`);
      }
      const result = attempt(() => core.listSongs(db, sqlite, options));
      // `total` is the filtered count BEFORE pagination — what a pager needs.
      return Promise.resolve(ok(result.songs.map(enrich), { total: result.total }));
    },
    getSong: (id) =>
      Promise.resolve(ok(enrich(attempt(() => core.getSong(db, sqlite, validId(id)))))),
    updateSong: (id, patch) => {
      writable();
      if (patch.name !== undefined) capped(patch.name, NAME_MAX, '歌名');
      if (patch.artist !== undefined) capped(patch.artist, NAME_MAX, '歌手名');
      const updated = attempt(() => core.updateSong(db, sqlite, validId(id), patch));
      return Promise.resolve(ok(enrich(updated)));
    },
    deleteSong: async (id) => {
      writable();
      // Async since v0.2: the row and the file removal are two steps now (a
      // journal entry between them), and the command must not exit before the
      // files it promised to delete are gone.
      await attemptAsync(() => core.deleteSong(db, sqlite, validId(id)));
      return ok({ id }, { message: 'song deleted' });
    },
    pinSong: (id, pinned) => {
      writable();
      attempt(() => core.setPinned(db, sqlite, validId(id), pinned));
      return Promise.resolve(ok(enrich(attempt(() => core.getSong(db, sqlite, validId(id))))));
    },

    // ── Playlists ──────────────────────────────────────
    listPlaylists: () => {
      // The virtual `all` comes FIRST, exactly as the daemon composes it
      // (R3/R24). It is not a row, so core does not return it — and a list
      // that differs between the two backends would make every name-based
      // reference resolve differently depending on whether a daemon happened
      // to be running.
      const virtualAll: PlaylistData = {
        id: VIRTUAL_ALL_PLAYLIST_ID,
        name: VIRTUAL_ALL_PLAYLIST_ID,
        created_at: 0,
        updated_at: 0,
        // `limit: 0` fetches no rows but still reports the count.
        song_count: attempt(() => core.listSongs(db, sqlite, { limit: 0 })).total,
      };
      const rows = [virtualAll, ...attempt(() => core.listPlaylists(db, sqlite))];
      return Promise.resolve(ok(rows, { total: rows.length }));
    },
    createPlaylist: (name) => {
      writable();
      const created = attempt(() =>
        core.createPlaylist(db, sqlite, capped(name, NAME_MAX, '歌单名')),
      );
      return Promise.resolve(ok(created as PlaylistData));
    },
    renamePlaylist: (id, name) => {
      writable();
      const renamed = attempt(() =>
        core.renamePlaylist(db, sqlite, writablePlaylistId(id), capped(name, NAME_MAX, '歌单名')),
      );
      return Promise.resolve(ok(renamed as PlaylistData));
    },
    deletePlaylist: (id) => {
      writable();
      attempt(() => core.deletePlaylist(db, sqlite, writablePlaylistId(id)));
      return Promise.resolve(ok({ id }, { message: 'playlist deleted' }));
    },
    listPlaylistSongs: (id) => {
      // The virtual playlist is every song in creation order — the same list
      // the library view shows by default.
      const songs =
        id === VIRTUAL_ALL_PLAYLIST_ID
          ? attempt(() => core.listSongs(db, sqlite, { sort: 'created_at', order: 'asc' })).songs
          : attempt(() => core.getPlaylistSongs(db, sqlite, readableId(id)));
      return Promise.resolve(ok(songs.map(enrich), { total: songs.length }));
    },
    addPlaylistSongs: (id, songIds) => {
      writable();
      if (songIds.length > SONG_IDS_MAX) throw usageError(`一次最多添加 ${SONG_IDS_MAX} 首。`);
      const added = attempt(() =>
        core.addSongsToPlaylist(db, sqlite, writablePlaylistId(id), songIds.map(validId)),
      );
      return Promise.resolve(ok({ added }));
    },
    removePlaylistSong: (id, songId) => {
      writable();
      attempt(() =>
        core.removeSongFromPlaylist(db, sqlite, writablePlaylistId(id), validId(songId)),
      );
      return Promise.resolve(
        ok({ playlist_id: id, song_id: songId }, { message: 'song removed from playlist' }),
      );
    },
    reorderPlaylist: (id, move) => {
      writable();
      const anchors: { before_song_id?: string; after_song_id?: string } = {};
      if (move.before_song_id !== undefined) anchors.before_song_id = move.before_song_id;
      if (move.after_song_id !== undefined) anchors.after_song_id = move.after_song_id;
      attempt(() =>
        core.reorderSong(db, sqlite, writablePlaylistId(id), validId(move.song_id), anchors),
      );
      return Promise.resolve(ok({ playlist_id: id }, { message: 'playlist reordered' }));
    },

    // ── Cache (M6-4) ───────────────────────────────────
    cacheStatus: () => {
      // `loadConfigReadonly`, not `loadConfig`: reading the limit must not
      // create a default config file or chmod an existing one (M6-23).
      const config = attempt(() => core.loadConfigReadonly());
      const status = attempt(() =>
        core.cacheStatus(db, {
          limitBytes: config.storage.cache_limit_mb * core.MIB,
          // Nothing is playing, nothing is queued: this process is the only
          // one holding the library, guaranteed by R31 + the writer lock.
          isExcluded: () => false,
          streamCount: () => 0,
        }),
      );
      return Promise.resolve(ok({ ...status, limit_mb: config.storage.cache_limit_mb }));
    },
    cacheEvict: async () => {
      writable();
      const config = attempt(() => core.loadConfig());
      const limitBytes = config.storage.cache_limit_mb * core.MIB;

      // A fresh registry: claims are an IN-PROCESS mutex, and this process is
      // the only writer (R31 + the writer lock held for the whole command).
      const claims = new core.ClaimRegistry();
      const bilibili = core.createBilibiliClient();
      const deps = {
        db,
        sqlite,
        bilibili,
        llm: null,
        // Carried for the type only: the eviction probe asks bilibili whether
        // a stored key still resolves, and never touches a media file.
        mediaTools: new core.MediaToolsRegistry(),
        timeouts: core.DEFAULT_TIMEOUTS,
      };

      const run = await attemptAsync(() =>
        core.runEviction(db, {
          limitBytes,
          isExcluded: () => false,
          streamCount: () => 0,
          acquireFileClaim: (songId: string) => {
            try {
              const token = claims.acquire(songId, 'file', 'cli-evict');
              return { release: () => claims.release(token) };
            } catch {
              return null;
            }
          },
          // Fail-closed (R26): anything but a clean yes keeps the file.
          probe: async (sourceKey: string) =>
            (await core.probeSourceKey(deps, sourceKey, {
              signal: AbortSignal.timeout(core.DEFAULT_TIMEOUTS.bilibiliMeta),
              reportStage: () => {},
            })) !== null,
        }),
      );

      const after = attempt(() =>
        core.cacheStatus(db, { limitBytes, isExcluded: () => false, streamCount: () => 0 }),
      );
      return ok(
        {
          ...after,
          limit_mb: config.storage.cache_limit_mb,
          evicted_count: run.evicted.length,
          freed_bytes: run.evicted.reduce((sum, e) => sum + e.freed_bytes, 0),
          skipped_unverified_count: run.skipped_unverified.length,
          skipped_unverified_bytes: run.skipped_unverified.reduce((sum, s) => sum + s.bytes, 0),
        },
        { message: 'cache eviction finished' },
      );
    },

    // ── Download / source url (daemon only) ────────────
    //
    // These reject rather than approximate. Downloading needs the queue, the
    // claim registry and one shared bilibili client (two clients are two
    // identities to the risk-control system, M3); recognising a URL is a
    // network call the daemon owns. `decideMode` refuses `--direct` on these
    // commands before a backend is ever built — this is the second wall, for
    // the day a command asks for the wrong `need`.
    parseInput: () => Promise.reject(daemonOnly('解析下载输入')),
    downloadSong: () => Promise.reject(daemonOnly('下载')),
    fetchList: () => Promise.reject(daemonOnly('展开收藏夹 / 合集')),
    downloadBatch: () => Promise.reject(daemonOnly('批量下载')),
    downloadTasks: () => Promise.reject(daemonOnly('查看下载队列')),
    redownloadSong: () => Promise.reject(daemonOnly('重新下载')),
    recognizeUrl: () => Promise.reject(daemonOnly('联网识别链接')),
    downloadLyrics: () => Promise.reject(daemonOnly('下载歌词')),
    // Playback lives in the GUI, and only the daemon can talk to it.
    playerStatus: () => Promise.reject(daemonOnly('查看播放状态')),
    playerCommand: () => Promise.reject(daemonOnly('播放控制')),

    // ── Sync (v0.2 T5) ─────────────────────────────────
    //
    // The session, the token refresh and the round coalescer all live in the
    // daemon; a second syncer in a CLI process would push the same changes
    // under a second identity. Unbind is the one that goes the other way.
    syncStatus: () => Promise.reject(daemonOnly('查看同步状态')),
    syncLogin: () => Promise.reject(daemonOnly('登录同步')),
    syncLogout: () => Promise.reject(daemonOnly('登出同步')),
    syncRun: () => Promise.reject(daemonOnly('执行同步')),
    syncFileOps: () => Promise.reject(daemonOnly('查看同步文件操作')),
    syncFileOpsRetry: () => Promise.reject(daemonOnly('重试同步文件操作')),
    syncFileOpsDiscard: () => Promise.reject(daemonOnly('放弃同步文件操作')),

    syncPendingChanges: () => {
      const pending = core.countUnpushedChanges(sqlite);
      return Promise.resolve(
        ok({ total: pending.total, unpublished_deletes: pending.unpublishedDeletes }),
      );
    },

    syncUnbind: async ({ force }) => {
      writable();
      // The journal is drained with a runtime this process owns alone: R31
      // guarantees no daemon, and the writer lock excludes the other three
      // writers, so a fresh claim registry is the whole truth here.
      const fileOps = new core.FileEffectRuntime({ sqlite });
      const result = await attemptAsync(() => core.unbindLibrary({ sqlite, fileOps, force }));
      return ok(
        {
          changes: result.changes,
          tombstones: result.tombstones,
          dead_letters: result.deadLetters,
          cursors: result.cursors,
          discarded_changes: result.discarded.total,
          discarded_deletes: result.discarded.unpublishedDeletes,
          had_credentials: result.hadCredentials,
          backfill_target: result.backfillTarget,
        },
        { message: 'unbound from the workspace' },
      );
    },

    // ── Lyrics (local file) ────────────────────────────
    deleteLyrics: async (id) => {
      writable();
      // The daemon takes a `lyrics` claim here to close the window between
      // "is there a file?" and "delete it". There is no window to close in
      // this process: R31 guarantees no daemon, and the writer lock excludes
      // every other writer, so this process is the only one that could be
      // writing that file.
      const deleted = await attemptAsync(() => core.deleteLyrics(db, validId(id)));
      if (!deleted) throw new CliError('LYRICS_NOT_FOUND', '这首歌没有歌词文件。');
      return ok({ id }, { message: 'lyrics deleted' });
    },

    // ── Transfer ───────────────────────────────────────
    exportPlaylist: (id) => {
      const source =
        id === VIRTUAL_ALL_PLAYLIST_ID
          ? { playlistId: null, name: VIRTUAL_ALL_PLAYLIST_ID }
          : { playlistId: validId(id) };
      return Promise.resolve(ok(attempt(() => core.buildExport(db, source))));
    },
    importPreview: async (filePath) => {
      const file = await attemptAsync(async () =>
        core.parseAndValidate(await readImportFile(filePath)),
      );
      return ok(attempt(() => core.previewImport(db, file)));
    },
    importPlaylist: async (request: ImportCommitRequest) => {
      writable();
      // The file is re-read here rather than carried over from the preview,
      // and the digest is what makes that safe: identical bytes mean
      // `reuse[].index` still points at the entry the user saw (M5-13).
      const file = await attemptAsync(async () =>
        core.parseAndValidate(await readImportFile(request.file_path)),
      );
      if (file.digest !== request.digest) {
        throw new CliError('IMPORT_SOURCE_CHANGED', '文件在预览之后发生了变化，请重新预览再导入');
      }
      const target = toCoreTarget(request.target);
      const result = attempt(() =>
        core.importPlaylist(db, sqlite, {
          entries: file.entries,
          target,
          ...(request.reuse === undefined ? {} : { reuse: [...request.reuse] }),
        }),
      );
      return ok(result, {
        message: `导入 ${result.total} 首：新建 ${result.created}，复用 ${result.reused}`,
      });
    },
  };
}

/** What the direct backend says about the things only a daemon can do (M6-5). */
function daemonOnly(what: string): CliError {
  return new CliError('USAGE_ERROR', `${what}需要一个运行中的 daemon——去掉 --direct 重试。`);
}

/** Same 20MB ceiling the daemon enforces (§4.1). */
const IMPORT_FILE_MAX_BYTES = 20 * 1024 * 1024;

const unreadable = (filePath: string, err: unknown): CliError =>
  new CliError(
    'INVALID_IMPORT_FILE',
    `无法读取 ${filePath}：${err instanceof Error ? err.message : String(err)}`,
  );

/**
 * Read an import file the way the daemon's route does, down to the error code:
 * `INVALID_IMPORT_FILE` for anything unreadable or oversized, with the size
 * checked before any bytes are read AND against the buffer that arrived.
 *
 * The parity matters because this is the file a user points at by hand —
 * "it says INVALID_IMPORT_FILE over HTTP and something else with --direct" is
 * exactly the kind of difference that makes the flag feel like a fork.
 */
async function readImportFile(filePath: string): Promise<Buffer> {
  const { readFile, stat } = await import('node:fs/promises');

  let size: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('不是一个文件');
    size = info.size;
  } catch (err) {
    throw unreadable(filePath, err);
  }
  const tooBig = (bytes: number): CliError =>
    new CliError(
      'INVALID_IMPORT_FILE',
      `导入文件最大 ${IMPORT_FILE_MAX_BYTES / (1024 * 1024)}MB（当前 ${Math.ceil(bytes / (1024 * 1024))}MB）`,
    );
  if (size > IMPORT_FILE_MAX_BYTES) throw tooBig(size);

  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (err) {
    throw unreadable(filePath, err);
  }
  // A file that grew between the stat and the read.
  if (buffer.byteLength > IMPORT_FILE_MAX_BYTES) throw tooBig(buffer.byteLength);
  return buffer;
}

/** The wire's `all` is core's `library`: songs land, no membership rows. */
function toCoreTarget(
  target: ImportCommitRequest['target'],
): Parameters<Core['importPlaylist']>[2]['target'] {
  switch (target.kind) {
    case 'all':
      return { kind: 'library' };
    case 'playlist':
      return { kind: 'playlist', playlistId: target.playlist_id };
    case 'new':
      return { kind: 'new', name: target.name.slice(0, NAME_MAX) };
  }
}
