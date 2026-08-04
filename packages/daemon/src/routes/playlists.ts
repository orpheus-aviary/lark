// Playlists, plus the virtual `all` view (R3/R24).
//
// `all` exists ONLY here. core has no row for it and no concept of it, which
// is what keeps "every song" from becoming a membership table that has to be
// maintained (the Go version materialised it, and the M1 migration had to drop
// those rows). Reads synthesise it; every write against it is a 400 rather
// than a no-op, so a GUI bug surfaces immediately instead of silently
// dropping the user's edit.

import {
  addSongsToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylistSongs,
  listPlaylists,
  listSongs,
  removeSongFromPlaylist,
  renamePlaylist,
  reorderSong,
  songFileInfo,
} from '@lark/core';
import {
  API_PATHS,
  type PlaylistData,
  type SongData,
  VIRTUAL_ALL_PLAYLIST_ID,
  apiPath,
} from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ok } from '../response.js';
import {
  InvalidRequestError,
  objectBody,
  optionalUuid,
  pathUuid,
  requiredString,
  requiredUuid,
  requiredUuidList,
} from '../validation.js';

const NAME_MAX = 500;
const SONG_IDS_MAX = 1000;

/** An id acceptable to a READ route: a real playlist, or the virtual one. */
function readableId(raw: string): string {
  return raw === VIRTUAL_ALL_PLAYLIST_ID ? raw : pathUuid(raw);
}

/** An id acceptable to a WRITE route: `all` is read-only. */
function writableId(raw: string): string {
  if (raw === VIRTUAL_ALL_PLAYLIST_ID) {
    throw new InvalidRequestError(
      'VIRTUAL_PLAYLIST',
      'the virtual "all" playlist is read-only: it cannot be renamed, deleted, or edited',
    );
  }
  return pathUuid(raw);
}

const rawId = (req: { params: unknown }): string => (req.params as { id: string }).id;

export function registerPlaylistRoutes(app: FastifyInstance, ctx: AppContext): void {
  const enrich = (song: SongData): SongData => ({ ...song, ...songFileInfo(song.id) });
  const changed = (): void => {
    ctx.eventsBus.emit({ type: 'playlists:changed' });
  };

  /** `limit: 0` fetches no rows but still reports the count. */
  const songTotal = (): number => listSongs(ctx.db, ctx.sqlite, { limit: 0 }).total;

  const virtualAll = (): PlaylistData => ({
    id: VIRTUAL_ALL_PLAYLIST_ID,
    name: VIRTUAL_ALL_PLAYLIST_ID,
    created_at: 0,
    updated_at: 0,
    song_count: songTotal(),
  });

  app.get(API_PATHS.playlists, async (_req, reply) => {
    const playlists = [virtualAll(), ...listPlaylists(ctx.db, ctx.sqlite)];
    ok(reply, playlists, undefined, playlists.length);
  });

  app.post(API_PATHS.playlists, async (req, reply) => {
    const body = objectBody(req.body, ['name']);
    const playlist = createPlaylist(
      ctx.db,
      ctx.sqlite,
      requiredString(body, 'name', { maxLength: NAME_MAX }),
    );
    changed();
    ok(reply, playlist);
  });

  app.get(apiPath.playlist(':id'), async (req, reply) => {
    const id = readableId(rawId(req));
    if (id === VIRTUAL_ALL_PLAYLIST_ID) return ok(reply, virtualAll());
    ok(reply, getPlaylist(ctx.db, ctx.sqlite, id));
  });

  app.put(apiPath.playlist(':id'), async (req, reply) => {
    const id = writableId(rawId(req));
    const body = objectBody(req.body, ['name']);
    const playlist = renamePlaylist(
      ctx.db,
      ctx.sqlite,
      id,
      requiredString(body, 'name', { maxLength: NAME_MAX }),
    );
    changed();
    ok(reply, playlist);
  });

  app.delete(apiPath.playlist(':id'), async (req, reply) => {
    const id = writableId(rawId(req));
    deletePlaylist(ctx.db, ctx.sqlite, id);
    changed();
    ok(reply, { id }, 'playlist deleted');
  });

  app.get(apiPath.playlistSongs(':id'), async (req, reply) => {
    const id = readableId(rawId(req));
    // `all` is every song in creation order — the same list the library view
    // shows by default. Real playlists come back in rank order (R23).
    const songs =
      id === VIRTUAL_ALL_PLAYLIST_ID
        ? listSongs(ctx.db, ctx.sqlite, { sort: 'created_at', order: 'asc' }).songs
        : getPlaylistSongs(ctx.db, ctx.sqlite, id);
    ok(reply, songs.map(enrich), undefined, songs.length);
  });

  app.post(apiPath.playlistSongs(':id'), async (req, reply) => {
    const id = writableId(rawId(req));
    const body = objectBody(req.body, ['song_ids']);
    const added = addSongsToPlaylist(
      ctx.db,
      ctx.sqlite,
      id,
      requiredUuidList(body, 'song_ids', SONG_IDS_MAX),
    );
    changed();
    ok(reply, { added });
  });

  app.delete(apiPath.playlistSong(':id', ':songId'), async (req, reply) => {
    const params = req.params as { id: string; songId: string };
    const id = writableId(params.id);
    removeSongFromPlaylist(ctx.db, ctx.sqlite, id, pathUuid(params.songId));
    changed();
    ok(reply, { playlist_id: id, song_id: params.songId }, 'song removed from playlist');
  });

  // Reorder is expressed with NEIGHBOUR ids, never a rank or an index (R7):
  // ranks are sparse floats the wire never sees, and an index would be stale
  // the moment another window reordered the same list.
  app.post(apiPath.playlistReorder(':id'), async (req, reply) => {
    const id = writableId(rawId(req));
    const body = objectBody(req.body, ['song_id', 'before_song_id', 'after_song_id']);
    reorderSong(ctx.db, ctx.sqlite, id, requiredUuid(body, 'song_id'), {
      before_song_id: optionalUuid(body, 'before_song_id'),
      after_song_id: optionalUuid(body, 'after_song_id'),
    });
    changed();
    ok(reply, { playlist_id: id }, 'playlist reordered');
  });
}
