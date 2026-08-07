// `lark playlist …` (M6-22).
//
// The virtual `all` playlist (R3/R24) is the recurring subtlety: it is a view,
// not a row, so it can be listed and exported but never renamed, deleted or
// written to. `resolvePlaylistRef` enforces that per call site rather than
// leaving each command to remember.

import type { PlaylistData } from '@lark/shared';
import type { CommandContext } from '../context.js';
import { confirm } from '../lib/confirm.js';
import { usageError } from '../lib/errors.js';
import { emitEnvelope } from '../lib/output.js';
import { playlistLine, songLine } from '../lib/render.js';
import { resolvePlaylistRef, resolveSongRef } from '../lib/resolve-ref.js';

export async function runPlaylistList(ctx: CommandContext): Promise<void> {
  const envelope = await ctx.backend.listPlaylists();
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const playlists = envelope.data ?? [];
  if (playlists.length === 0) return ctx.streams.out('（没有歌单）');
  for (const playlist of playlists) ctx.streams.out(playlistLine(playlist));
}

export async function runPlaylistSongs(ctx: CommandContext, ref: string): Promise<void> {
  const id = await resolvePlaylistRef(ctx.backend, ref, { allowAll: true });
  const envelope = await ctx.backend.listPlaylistSongs(id);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const songs = envelope.data ?? [];
  if (songs.length === 0) return ctx.streams.out('（这个歌单是空的）');
  for (const song of songs) ctx.streams.out(songLine(song));
}

export async function runPlaylistCreate(ctx: CommandContext, name: string): Promise<void> {
  const envelope = await ctx.backend.createPlaylist(name);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);
  ctx.streams.out(`✓ 已创建歌单 ${(envelope.data as PlaylistData).name}`);
}

export async function runPlaylistRename(
  ctx: CommandContext,
  ref: string,
  name: string,
): Promise<void> {
  const id = await resolvePlaylistRef(ctx.backend, ref);
  const envelope = await ctx.backend.renamePlaylist(id, name);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);
  ctx.streams.out(`✓ 已改名为 ${(envelope.data as PlaylistData).name}`);
}

export async function runPlaylistDelete(ctx: CommandContext, ref: string): Promise<void> {
  const id = await resolvePlaylistRef(ctx.backend, ref);

  await confirm(`删除歌单「${ref}」？（歌曲本身不会被删除）`, {
    yes: ctx.flags.yes,
    json: ctx.flags.json,
  });

  const envelope = await ctx.backend.deletePlaylist(id);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);
  ctx.streams.out('✓ 已删除歌单');
}

export async function runPlaylistAdd(
  ctx: CommandContext,
  playlistRef: string,
  songRefs: readonly string[],
): Promise<void> {
  const id = await resolvePlaylistRef(ctx.backend, playlistRef);
  const songIds: string[] = [];
  for (const ref of songRefs) songIds.push(await resolveSongRef(ctx.backend, ref));

  // One request for the whole set: the daemon adds them in a single
  // transaction, so a partial add is not a state the CLI can produce.
  const envelope = await ctx.backend.addPlaylistSongs(id, songIds);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);
  ctx.streams.out(`✓ 已添加 ${envelope.data?.added ?? 0} 首（重复的会被跳过）`);
}

export async function runPlaylistRemove(
  ctx: CommandContext,
  playlistRef: string,
  songRef: string,
): Promise<void> {
  const id = await resolvePlaylistRef(ctx.backend, playlistRef);
  const songId = await resolveSongRef(ctx.backend, songRef);
  const envelope = await ctx.backend.removePlaylistSong(id, songId);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);
  ctx.streams.out('✓ 已从歌单移除');
}

export interface ReorderOptions {
  before?: string;
  after?: string;
}

export async function runPlaylistReorder(
  ctx: CommandContext,
  playlistRef: string,
  songRef: string,
  opts: ReorderOptions,
): Promise<void> {
  // Neighbour ids, never an index (R7): an index is stale the moment another
  // window reorders the same list.
  if ((opts.before === undefined) === (opts.after === undefined)) {
    throw usageError('给 --before <歌> 或 --after <歌> 其中一个（不能都给，也不能都不给）');
  }

  const id = await resolvePlaylistRef(ctx.backend, playlistRef);
  const songId = await resolveSongRef(ctx.backend, songRef);
  const move: { song_id: string; before_song_id?: string; after_song_id?: string } = {
    song_id: songId,
  };
  if (opts.before !== undefined)
    move.before_song_id = await resolveSongRef(ctx.backend, opts.before);
  if (opts.after !== undefined) move.after_song_id = await resolveSongRef(ctx.backend, opts.after);

  const envelope = await ctx.backend.reorderPlaylist(id, move);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);
  ctx.streams.out('✓ 已调整顺序');
}
