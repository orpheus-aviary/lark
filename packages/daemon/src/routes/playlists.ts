// Playlists, plus the virtual `all` view (R3/R24).
//
// `all` exists ONLY here. core has no row for it and no concept of it, which
// is what keeps "every song" from becoming a membership table that has to be
// maintained (the Go version materialised it, and the M1 migration had to drop
// those rows). Reads synthesise it; every write against it is a 400 rather
// than a no-op, so a GUI bug surfaces immediately instead of silently
// dropping the user's edit.

import { readFile, stat } from 'node:fs/promises';
import { IMPORT_SONGS_MAX, type ImportTarget, type LibraryService } from '@lark/core';
import {
  API_PATHS,
  PLAYLIST_NAME_MAX,
  type PlaylistData,
  type PlaylistImportTarget,
  VIRTUAL_ALL_PLAYLIST_ID,
  apiPath,
} from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { libraryService } from '../library-service.js';
import { ok } from '../response.js';
import {
  InvalidRequestError,
  objectBody,
  optionalUuid,
  pathUuid,
  requiredSafeInteger,
  requiredString,
  requiredStringField,
  requiredTarget,
  requiredUuid,
  requiredUuidList,
} from '../validation.js';

/**
 * Import guardrails (M5-13). The file arrives as a PATH, not as a body: 20MB
 * is twenty times Fastify's body limit, and `POST /songs/import` already set
 * the precedent for a local daemon reading local files.
 */
const IMPORT_FILE_MAX_BYTES = 20 * 1024 * 1024;
const IMPORT_PATH_MAX = 4096;
const DIGEST_RE = /^[0-9a-f]{64}$/;

const unreadable = (filePath: string, err: unknown): InvalidRequestError =>
  new InvalidRequestError(
    'INVALID_IMPORT_FILE',
    `无法读取 ${filePath}：${err instanceof Error ? err.message : String(err)}`,
  );

/**
 * Read an import file with the size checked twice: `stat` refuses the obvious
 * case before any bytes are read, and the buffer's own length is what the
 * limit is finally enforced against — the two are separate syscalls, and the
 * file can grow between them.
 */
async function readImportFile(filePath: string): Promise<Buffer> {
  let size: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('不是一个文件');
    size = info.size;
  } catch (err) {
    throw unreadable(filePath, err);
  }
  const tooBig = (bytes: number): InvalidRequestError =>
    new InvalidRequestError(
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
  if (buffer.byteLength > IMPORT_FILE_MAX_BYTES) throw tooBig(buffer.byteLength);
  return buffer;
}

/** `all` is the API's virtual id; core is told "the library" instead (M5-12). */
function toCoreTarget(target: PlaylistImportTarget): ImportTarget {
  if (target.kind === 'playlist') return { kind: 'playlist', playlistId: target.playlist_id };
  if (target.kind === 'new') return { kind: 'new', name: target.name };
  return { kind: 'library' };
}

function readReuse(raw: unknown): { index: number; song_id: string }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new InvalidRequestError('INVALID_BODY', 'reuse must be an array');
  }
  if (raw.length > IMPORT_SONGS_MAX) {
    throw new InvalidRequestError('INVALID_BODY', `reuse must hold at most ${IMPORT_SONGS_MAX}`);
  }
  return raw.map((entry) => {
    const item = objectBody(entry, ['index', 'song_id']);
    return {
      index: requiredSafeInteger(item, 'index', { min: 0, max: IMPORT_SONGS_MAX - 1 }),
      song_id: requiredUuid(item, 'song_id'),
    };
  });
}

/** An id acceptable to a READ route: a real playlist, or the virtual one. */
function readableId(raw: string): string {
  return raw === VIRTUAL_ALL_PLAYLIST_ID ? raw : pathUuid(raw);
}

const rawId = (req: { params: unknown }): string => (req.params as { id: string }).id;

/** Include an optional anchor only when it is actually there (exactOptionalPropertyTypes). */
const pick = <K extends string>(
  key: K,
  value: string | undefined,
): Record<K, string> | undefined =>
  value === undefined ? undefined : ({ [key]: value } as Record<K, string>);

export function registerPlaylistRoutes(app: FastifyInstance, ctx: AppContext): void {
  const lib = (): LibraryService => libraryService(ctx);
  const changed = (): void => {
    ctx.eventsBus.emit({ type: 'playlists:changed' });
  };

  /**
   * The virtual playlist, taken from the one place that composes it (N1g).
   *
   * The route used to build its own, which is how the daemon and `--direct`
   * came to disagree about what listing playlists returns. Asking the service
   * costs one extra count on a rarely-taken path and removes the second
   * definition entirely.
   */
  const virtualAll = (): PlaylistData => {
    const [all] = lib().listPlaylists();
    return all as PlaylistData;
  };

  app.get(API_PATHS.playlists, async (_req, reply) => {
    const playlists = lib().listPlaylists();
    ok(reply, playlists, undefined, playlists.length);
  });

  app.post(API_PATHS.playlists, async (req, reply) => {
    const body = objectBody(req.body, ['name']);
    const playlist = lib().createPlaylist(requiredStringField(body, 'name'));
    changed();
    ok(reply, playlist);
  });

  app.get(apiPath.playlist(':id'), async (req, reply) => {
    const id = rawId(req);
    if (id === VIRTUAL_ALL_PLAYLIST_ID) return ok(reply, virtualAll());
    ok(reply, lib().getPlaylist(id));
  });

  app.put(apiPath.playlist(':id'), async (req, reply) => {
    const id = rawId(req);
    const body = objectBody(req.body, ['name']);
    const playlist = lib().renamePlaylist(id, requiredStringField(body, 'name'));
    changed();
    ok(reply, playlist);
  });

  app.delete(apiPath.playlist(':id'), async (req, reply) => {
    const id = rawId(req);
    lib().deletePlaylist(id);
    changed();
    ok(reply, { id }, 'playlist deleted');
  });

  app.get(apiPath.playlistSongs(':id'), async (req, reply) => {
    // `all` is every song in creation order — the same list the library view
    // shows by default. Real playlists come back in rank order (R23).
    const songs = lib().listPlaylistSongs(rawId(req));
    ok(reply, songs, undefined, songs.length);
  });

  app.post(apiPath.playlistSongs(':id'), async (req, reply) => {
    const id = rawId(req);
    const body = objectBody(req.body, ['song_ids']);
    const added = lib().addPlaylistSongs(id, requiredUuidList(body, 'song_ids'));
    changed();
    ok(reply, { added });
  });

  app.delete(apiPath.playlistSong(':id', ':songId'), async (req, reply) => {
    const params = req.params as { id: string; songId: string };
    const id = params.id;
    lib().removePlaylistSong(id, params.songId);
    changed();
    ok(reply, { playlist_id: id, song_id: params.songId }, 'song removed from playlist');
  });

  // ─── Transfer (M5-12 / M5-13) ────────────────────────

  /**
   * Export a playlist — or the whole library, through the virtual `all` — as
   * the interchange file. A plain envelope, not a download response: the GUI
   * saves it through a native dialog and the CLI writes it where it was told,
   * so a `Content-Disposition` here would serve neither.
   */
  app.get(apiPath.playlistExport(':id'), async (req, reply) => {
    const id = rawId(req);
    ok(
      reply,
      lib().buildExport(
        id === VIRTUAL_ALL_PLAYLIST_ID
          ? { playlistId: null, name: VIRTUAL_ALL_PLAYLIST_ID }
          : { playlistId: readableId(id) },
      ),
    );
  });

  /** Read + validate the file and say what importing it would do. Writes nothing. */
  app.post(API_PATHS.playlistImportPreview, async (req, reply) => {
    const body = objectBody(req.body, ['file_path']);
    const filePath = requiredString(body, 'file_path', { maxLength: IMPORT_PATH_MAX });
    const service = lib();
    const file = await service.parseImportFile(await readImportFile(filePath));
    ok(reply, service.previewImport(file));
  });

  /**
   * Commit the import, all songs or none (R27).
   *
   * The file is read AGAIN rather than carried over from the preview, and the
   * digest is what makes that safe: identical bytes mean `reuse[].index` still
   * points at the entry the user was looking at. A changed file is a refusal,
   * never a best-effort import against shifted indices (M5-13).
   */
  app.post(API_PATHS.playlistImport, async (req, reply) => {
    const body = objectBody(req.body, ['file_path', 'digest', 'target', 'reuse']);
    const filePath = requiredString(body, 'file_path', { maxLength: IMPORT_PATH_MAX });
    const digest = requiredString(body, 'digest', { maxLength: 64 });
    if (!DIGEST_RE.test(digest)) {
      throw new InvalidRequestError('INVALID_BODY', 'digest must be a hex SHA-256');
    }
    const target = requiredTarget(body.target, PLAYLIST_NAME_MAX);
    const reuse = readReuse(body.reuse);

    const service = lib();
    const file = await service.parseImportFile(await readImportFile(filePath));
    if (file.digest !== digest) {
      throw new InvalidRequestError(
        'IMPORT_SOURCE_CHANGED',
        '文件在预览之后发生了变化，请重新预览再导入',
      );
    }

    const result = service.importPlaylist({
      entries: file.entries,
      target: toCoreTarget(target),
      reuse,
    });
    ctx.eventsBus.emit({ type: 'songs:changed' });
    ctx.eventsBus.emit({ type: 'playlists:changed' });
    ok(reply, result, `导入 ${result.total} 首：新建 ${result.created}，复用 ${result.reused}`);
  });

  // Reorder is expressed with NEIGHBOUR ids, never a rank or an index (R7):
  // ranks are sparse floats the wire never sees, and an index would be stale
  // the moment another window reordered the same list.
  app.post(apiPath.playlistReorder(':id'), async (req, reply) => {
    const id = rawId(req);
    const body = objectBody(req.body, ['song_id', 'before_song_id', 'after_song_id']);
    lib().reorderPlaylist(id, {
      song_id: requiredUuid(body, 'song_id'),
      ...pick('before_song_id', optionalUuid(body, 'before_song_id')),
      ...pick('after_song_id', optionalUuid(body, 'after_song_id')),
    });
    changed();
    ok(reply, { playlist_id: id }, 'playlist reordered');
  });
}
