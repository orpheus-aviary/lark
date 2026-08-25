import { randomUUID } from 'node:crypto';
import {
  type ClaimType,
  FileEffectRuntime,
  type UpdateSongInput,
  getSong,
  importSongs,
  isLlmConfigured,
  recognizeSourceUrl,
  resolveLlmConfig,
  resolveSourceUrl,
  songFileInfo,
} from '@lark/core';
import {
  API_PATHS,
  type DownloadTaskAcceptedData,
  type RecognizeUrlData,
  SONG_SORT_FIELDS,
  SONG_SOURCE_KEY_MAX,
  SONG_SOURCE_PROVIDER_MAX,
  SONG_SOURCE_URL_MAX,
  SORT_ORDERS,
  apiPath,
} from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { libraryService } from '../library-service.js';
import { ok } from '../response.js';
import {
  InvalidRequestError,
  objectBody,
  optionalNumber,
  optionalString,
  pathUuid,
  queryEnum,
  queryInteger,
  queryParams,
  queryString,
  requireFields,
  requiredBoolean,
  stringField,
} from '../validation.js';

/**
 * Fields `PUT /songs/:id` accepts. Online normalisation of a pasted URL into
 * (provider, key) is M3 — here the client sends the source triple explicitly
 * and core's `normalizeSource` rules on the combination (M1 four quadrants).
 */
const SONG_UPDATE_FIELDS = [
  'name',
  'artist',
  'lyrics_offset',
  'duration',
  'source_url',
  'source_provider',
  'source_key',
] as const;

const IMPORT_PATHS_MAX = 200;
const IMPORT_PATH_MAX = 4096;

const idOf = (req: { params: unknown }): string => pathUuid((req.params as { id: string }).id);

export function registerSongRoutes(app: FastifyInstance, ctx: AppContext): void {
  const bilibili = ctx.bilibili;
  const netSignal = (): AbortSignal =>
    AbortSignal.any([ctx.shutdownSignal, AbortSignal.timeout(60_000)]);

  /**
   * Hold a claim for the duration of one route operation (M3-7).
   *
   * A fresh owner per call, because two concurrent requests for the same song
   * must block each other — unlike a task and its own reservation, which share
   * an owner precisely so they do not.
   */
  const withClaim = async <T>(
    songId: string,
    type: ClaimType,
    body: () => Promise<T> | T,
  ): Promise<T> => {
    const token = ctx.downloads.claims.acquire(songId, type, `route:${randomUUID()}`);
    try {
      return await body();
    } finally {
      ctx.downloads.claims.release(token);
    }
  };

  app.get(API_PATHS.songs, async (req, reply) => {
    const query = queryParams(req.query, ['search', 'sort', 'order', 'limit', 'offset']);
    const result = libraryService(ctx).listSongs({
      search: queryString(query, 'search'),
      sort: queryEnum(query, 'sort', SONG_SORT_FIELDS),
      order: queryEnum(query, 'order', SORT_ORDERS),
      limit: queryInteger(query, 'limit', { min: 1 }),
      offset: queryInteger(query, 'offset', { min: 0 }),
    });
    // `total` is the filtered count BEFORE pagination — what a pager needs.
    ok(reply, result.songs, undefined, result.total);
  });

  app.get(apiPath.song(':id'), async (req, reply) => {
    ok(reply, libraryService(ctx).getSong(idOf(req)));
  });

  app.put(apiPath.song(':id'), async (req, reply) => {
    const id = idOf(req);
    const body = requireFields(objectBody(req.body, SONG_UPDATE_FIELDS));

    const patch: UpdateSongInput = {};
    // Verbatim on purpose: 'is this a string' is the wire's question, 'is it a
    // usable name' is the library's, and the library has to be the one that
    // trims or its rule is only enforced where somebody else happened to
    // trim first (N1g).
    const name = stringField(body, 'name');
    if (typeof name === 'string') patch.name = name;
    const artist = stringField(body, 'artist');
    if (typeof artist === 'string') patch.artist = artist;
    const lyricsOffset = optionalNumber(body, 'lyrics_offset');
    if (lyricsOffset !== undefined) patch.lyrics_offset = lyricsOffset;
    const duration = optionalNumber(body, 'duration', { min: 0 });
    if (duration !== undefined) patch.duration = duration;
    // The source triple passes through verbatim (including explicit nulls, which
    // clear it): only core may judge the COMBINATION.
    if ('source_url' in body) {
      patch.source_url = optionalString(body, 'source_url', {
        maxLength: SONG_SOURCE_URL_MAX,
        allowEmpty: true,
        nullable: true,
      });
    }
    if ('source_provider' in body) {
      patch.source_provider = optionalString(body, 'source_provider', {
        maxLength: SONG_SOURCE_PROVIDER_MAX,
        allowEmpty: true,
        nullable: true,
      });
    }
    if ('source_key' in body) {
      patch.source_key = optionalString(body, 'source_key', {
        maxLength: SONG_SOURCE_KEY_MAX,
        allowEmpty: true,
        nullable: true,
      });
    }

    // A url-only edit is the paste-a-link case, and gets the four-branch
    // treatment (M3-11). When the client sends the triple explicitly it is
    // saying what it wants stored, and core's invariant is the only judge.
    const urlOnly = 'source_url' in body && !('source_provider' in body) && !('source_key' in body);
    if (urlOnly) {
      const resolved = await resolveSourceUrl(bilibili, patch.source_url ?? null, {
        signal: netSignal(),
      });
      patch.source_url = resolved.source_url;
      // Explicit nulls, not omission: `updateSongInTx` inherits absent fields,
      // so leaving these out would keep a stale key attached to a new url.
      patch.source_provider = resolved.source_provider;
      patch.source_key = resolved.source_key;
    }

    // The write may change which file this song points at, so it takes the
    // same claim a download would — the normalisation above ran outside it.
    const song = await withClaim(id, 'file', () => libraryService(ctx).updateSong(id, patch));
    ctx.eventsBus.emit({ type: 'songs:changed' });
    ok(reply, song);
  });

  app.delete(apiPath.song(':id'), async (req, reply) => {
    const id = idOf(req);
    // `exclusive`: deleting conflicts with every other writer, so an in-flight
    // download or lyrics fetch answers 409 rather than racing the delete.
    await withClaim(id, 'exclusive', () =>
      // A runtime of its OWN, not `ctx.fileOps`: this request already holds
      // the song's exclusive claim, and the shared registry would refuse the
      // drain its own caller is waiting for.
      // No logger, matching the default this replaced exactly: N1b is a
      // structural batch, and "the delete route now logs file-op failures" is
      // a behaviour change however welcome it would be.
      libraryService(ctx, {
        fileOps: new FileEffectRuntime({ sqlite: ctx.sqlite }),
      }).deleteSong(id),
    );
    // Memberships cascade, so every playlist view is stale too.
    ctx.eventsBus.emit({ type: 'songs:changed' });
    ctx.eventsBus.emit({ type: 'playlists:changed' });
    ok(reply, { id }, 'song deleted');
  });

  // ─── M3 additions ────────────────────────────────────

  /**
   * Import local audio files. Per-file outcomes: one unreadable file must not
   * cost the other 199 (M3-11), and from 0.3.0 an accepted one can still owe
   * the user a warning about what the conversion dropped (§3.4).
   */
  app.post(API_PATHS.songImport, async (req, reply) => {
    const body = objectBody(req.body, ['file_paths']);
    const paths = body.file_paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new InvalidRequestError('INVALID_BODY', 'file_paths must be a non-empty array');
    }
    if (paths.length > IMPORT_PATHS_MAX) {
      throw new InvalidRequestError(
        'INVALID_BODY',
        `at most ${IMPORT_PATHS_MAX} files per request`,
      );
    }
    for (const path of paths) {
      if (typeof path !== 'string' || path === '' || path.length > IMPORT_PATH_MAX) {
        throw new InvalidRequestError('INVALID_BODY', 'file_paths must contain absolute paths');
      }
    }

    // Throws `MEDIA_TOOLS_UNAVAILABLE` (503) when this machine has no usable
    // ffprobe, rather than reporting every path as a bad file (M7-18).
    const result = await importSongs(ctx.portable, ctx.mediaTools, paths as string[], {
      signal: ctx.shutdownSignal,
    });
    if (result.imported.length > 0) ctx.eventsBus.emit({ type: 'songs:changed' });
    ok(reply, result, `imported ${result.imported.length} of ${paths.length}`);
  });

  /**
   * Preview what a URL would resolve to. Writes nothing (R6) — the GUI shows
   * the answer and the user decides whether to save it through PUT.
   */
  app.post(apiPath.songRecognizeUrl(':id'), async (req, reply) => {
    const id = idOf(req);
    const song = getSong(ctx.db, ctx.sqlite, id);
    const body = objectBody(req.body, ['url']);
    const url = optionalString(body, 'url', { maxLength: SONG_SOURCE_URL_MAX }) ?? song.source_url;
    if (url === null || url === '') {
      throw new InvalidRequestError('INVALID_BODY', '这首歌没有链接，请在请求里给出 url');
    }

    // The recognition itself is portable (`download/source-url.ts`, N4i-1);
    // what stays here is the wire: which url to use when the body omits one,
    // the deadline, and the envelope.
    const recognized = await recognizeSourceUrl(bilibili, url, { signal: netSignal() });
    ok(reply, recognized satisfies RecognizeUrlData);
  });

  /** Force a fresh download of this song's audio, replacing whatever is there. */
  app.post(apiPath.songRedownload(':id'), async (req, reply) => {
    const id = idOf(req);
    const song = getSong(ctx.db, ctx.sqlite, id);
    // Without a key the task has to re-identify the song, which needs the LLM
    // — knowable here, so it is a 400 rather than an async failure.
    if (song.source_key === null && !isLlmConfigured(resolveLlmConfig(ctx.config))) {
      throw new InvalidRequestError(
        'LLM_NOT_CONFIGURED',
        '这首歌没有来源标识，重新下载需要配置 LLM（或先编辑它的链接）',
      );
    }
    const task = ctx.downloads.enqueueRedownload(id);
    ok(reply, { task_id: task.id } satisfies DownloadTaskAcceptedData, 'redownload queued');
  });

  /**
   * Make sure this song has an audio file, fetching it only if it is missing
   * (M5-8) — what the GUI sends when the user plays an evicted song.
   *
   * The guard is narrower than redownload's on purpose: it only fires when the
   * file is ACTUALLY missing. A song with a file but no source key (every
   * Go-era import) is the zero-network case, and rejecting it here would turn
   * the cheapest path into a 400.
   */
  app.post(apiPath.songEnsureFile(':id'), async (req, reply) => {
    const id = idOf(req);
    const song = getSong(ctx.db, ctx.sqlite, id);
    const missing = !songFileInfo(ctx.files, id, { audioMode: 'canonical' }).has_file;
    if (missing && song.source_key === null && !isLlmConfigured(resolveLlmConfig(ctx.config))) {
      throw new InvalidRequestError(
        'LLM_NOT_CONFIGURED',
        '这首歌没有本地文件也没有来源标识，需要配置 LLM 才能找回（或先编辑它的链接）',
      );
    }
    const task = ctx.downloads.enqueueEnsureFile(id);
    ok(reply, { task_id: task.id } satisfies DownloadTaskAcceptedData, 'ensure-file queued');
  });

  // Pinning is device-local (R18): it never touches updated_at / the LWW triple.
  app.put(apiPath.songPin(':id'), async (req, reply) => {
    const id = idOf(req);
    const body = objectBody(req.body, ['pinned']);
    const song = libraryService(ctx).pinSong(id, requiredBoolean(body, 'pinned'));
    ctx.eventsBus.emit({ type: 'songs:changed' });
    ok(reply, song);
  });
}
