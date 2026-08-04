import {
  type UpdateSongInput,
  deleteSong,
  getSong,
  listSongs,
  setPinned,
  songFileInfo,
  updateSong,
} from '@lark/core';
import { API_PATHS, SONG_SORT_FIELDS, SORT_ORDERS, type SongData, apiPath } from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ok } from '../response.js';
import {
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
} from '../validation.js';

const NAME_MAX = 500;
const ARTIST_MAX = 500;
const SOURCE_URL_MAX = 2048;
const SOURCE_KEY_MAX = 256;
const SOURCE_PROVIDER_MAX = 64;
const SEARCH_MAX = 200;
const LIMIT_MAX = 1000;

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

const idOf = (req: { params: unknown }): string => pathUuid((req.params as { id: string }).id);

export function registerSongRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** has_file / file_size are disk probes, not columns — added at the wire edge. */
  const enrich = (song: SongData): SongData => ({ ...song, ...songFileInfo(song.id) });

  app.get(API_PATHS.songs, async (req, reply) => {
    const query = queryParams(req.query, ['search', 'sort', 'order', 'limit', 'offset']);
    const result = listSongs(ctx.db, ctx.sqlite, {
      search: queryString(query, 'search', SEARCH_MAX),
      sort: queryEnum(query, 'sort', SONG_SORT_FIELDS),
      order: queryEnum(query, 'order', SORT_ORDERS),
      limit: queryInteger(query, 'limit', { min: 1, max: LIMIT_MAX }),
      offset: queryInteger(query, 'offset', { min: 0 }),
    });
    // `total` is the filtered count BEFORE pagination — what a pager needs.
    ok(reply, result.songs.map(enrich), undefined, result.total);
  });

  app.get(apiPath.song(':id'), async (req, reply) => {
    ok(reply, enrich(getSong(ctx.db, ctx.sqlite, idOf(req))));
  });

  app.put(apiPath.song(':id'), async (req, reply) => {
    const id = idOf(req);
    const body = requireFields(objectBody(req.body, SONG_UPDATE_FIELDS));

    const patch: UpdateSongInput = {};
    const name = optionalString(body, 'name', { maxLength: NAME_MAX });
    if (typeof name === 'string') patch.name = name;
    const artist = optionalString(body, 'artist', { maxLength: ARTIST_MAX, allowEmpty: true });
    if (typeof artist === 'string') patch.artist = artist;
    const lyricsOffset = optionalNumber(body, 'lyrics_offset');
    if (lyricsOffset !== undefined) patch.lyrics_offset = lyricsOffset;
    const duration = optionalNumber(body, 'duration', { min: 0 });
    if (duration !== undefined) patch.duration = duration;
    // The source triple passes through verbatim (including explicit nulls, which
    // clear it): only core may judge the COMBINATION.
    if ('source_url' in body) {
      patch.source_url = optionalString(body, 'source_url', {
        maxLength: SOURCE_URL_MAX,
        allowEmpty: true,
        nullable: true,
      });
    }
    if ('source_provider' in body) {
      patch.source_provider = optionalString(body, 'source_provider', {
        maxLength: SOURCE_PROVIDER_MAX,
        allowEmpty: true,
        nullable: true,
      });
    }
    if ('source_key' in body) {
      patch.source_key = optionalString(body, 'source_key', {
        maxLength: SOURCE_KEY_MAX,
        allowEmpty: true,
        nullable: true,
      });
    }

    const song = updateSong(ctx.db, ctx.sqlite, id, patch);
    ctx.eventsBus.emit({ type: 'songs:changed' });
    ok(reply, enrich(song));
  });

  app.delete(apiPath.song(':id'), async (req, reply) => {
    const id = idOf(req);
    deleteSong(ctx.db, ctx.sqlite, id);
    // Memberships cascade, so every playlist view is stale too.
    ctx.eventsBus.emit({ type: 'songs:changed' });
    ctx.eventsBus.emit({ type: 'playlists:changed' });
    ok(reply, { id }, 'song deleted');
  });

  // Pinning is device-local (R18): it never touches updated_at / the LWW triple.
  app.put(apiPath.songPin(':id'), async (req, reply) => {
    const id = idOf(req);
    const body = objectBody(req.body, ['pinned']);
    setPinned(ctx.db, ctx.sqlite, id, requiredBoolean(body, 'pinned'));
    ctx.eventsBus.emit({ type: 'songs:changed' });
    ok(reply, enrich(getSong(ctx.db, ctx.sqlite, id)));
  });
}
