// Remote `player:command` execution and its ack (§4.3 + M4-10).
//
// The daemon gives a command 3 seconds before it answers 504, so a command
// that has been waiting behind others for 2.5s is DROPPED rather than run:
// the caller has already been told it timed out, and executing it afterwards
// would change playback for a request nobody is waiting on any more.
//
// Everything runs on the player's single queue, so a remote command and a
// click on the same button cannot interleave — and any continuation that
// wakes up after a newer operation started reports `superseded` instead of
// writing stale state.

import type { AckRequest, PlayerCommandEvent, SongData } from '@lark/shared';
import { API_PATHS, apiPath, request } from '@lark/shared';
import { useLibrary } from '../stores/library.js';
import { type CommandResult, playerQueue, usePlayer } from '../stores/player.js';
import { invalidatePending } from './pending.js';
import { DISCARDED, type OperationContext } from './queue.js';

/** Daemon waits 3s; the rest is ack transit (M4-10). */
export const COMMAND_DEADLINE_MS = 2500;

/**
 * Find a song anywhere in the library. The current view is checked first —
 * the common case — and the daemon answers for everything else, which is the
 * Go version's "fall back to all songs" without pulling the whole list.
 */
async function findSong(songId: string): Promise<SongData | null> {
  const inView = useLibrary.getState().songs.find((song) => song.id === songId);
  if (inView) return inView;
  try {
    const envelope = await request<SongData>('GET', apiPath.song(songId));
    return envelope.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Load a playlist's members. Deliberately NOT lane-scoped: a list refresh
 * elsewhere must never abort a command's preload (M4-10).
 */
async function loadPlaylist(playlistId: string): Promise<readonly SongData[] | null> {
  try {
    const envelope = await request<SongData[]>('GET', apiPath.playlistSongs(playlistId));
    return envelope.data ?? null;
  } catch {
    return null;
  }
}

const SUPERSEDED: CommandResult = { ok: false, message: 'superseded' };

/**
 * `play-playlist` / `switch-playlist` (§4.3): load FIRST, switch second — a
 * playlist that cannot be loaded leaves the view exactly where it was. Once
 * the switch happens it STAYS, whatever becomes of the playback half.
 */
async function executePlaylistCommand(
  command: Extract<PlayerCommandEvent, { command: 'play-playlist' | 'switch-playlist' }>,
  ctx: OperationContext,
): Promise<CommandResult> {
  const songs = await loadPlaylist(command.playlist_id);
  if (!ctx.isCurrent()) return SUPERSEDED;
  if (songs === null) return { ok: false, message: '歌单加载失败' };
  useLibrary.getState().adoptPlaylistView(command.playlist_id, songs);
  if (command.command === 'switch-playlist') return { ok: true };

  const ops = usePlayer.getState().ops;
  if (command.song_id !== undefined) {
    const song = songs.find((s) => s.id === command.song_id) ?? (await findSong(command.song_id));
    if (!ctx.isCurrent()) return SUPERSEDED;
    if (!song) return { ok: false, message: '找不到这首歌' };
    return await ops.play(song, ctx);
  }

  const first = songs.find((song) => song.has_file !== false);
  if (!first) {
    return { ok: false, message: songs.length === 0 ? '歌单是空的' : '歌单里没有可播放的文件' };
  }
  return await ops.play(first, ctx);
}

async function execute(command: PlayerCommandEvent, ctx: OperationContext): Promise<CommandResult> {
  const player = usePlayer.getState();
  // The same invalidation the local actions do at dispatch (M5-9): a remote
  // command that changes what is playing retires the pending intent.
  if (command.command === 'play') invalidatePending({ supersede: true });
  else if (['pause', 'next', 'prev'].includes(command.command)) invalidatePending();

  switch (command.command) {
    case 'play': {
      const song = await findSong(command.song_id);
      if (!ctx.isCurrent()) return SUPERSEDED;
      if (!song) return { ok: false, message: '找不到这首歌' };
      // An explicit remote play is the same intent as a double click: a
      // missing file is downloaded and played, and the ack says so (M5-9).
      return await player.ops.play(song, ctx, { ensureFile: true });
    }

    case 'play-playlist':
    case 'switch-playlist':
      return await executePlaylistCommand(command, ctx);

    case 'pause':
      return await player.ops.pause();
    case 'resume':
      return await player.ops.resume(ctx);
    case 'next':
      return await player.ops.next(ctx);
    case 'prev':
      return await player.ops.prev(ctx);
    case 'seek':
      return await player.ops.seek(command.position);
    case 'mode':
      return await player.ops.setMode(command.mode);
  }
}

async function sendAck(requestId: string, result: CommandResult): Promise<void> {
  const body: AckRequest = { request_id: requestId, ok: result.ok };
  if (result.message !== undefined) body.message = result.message;
  try {
    await request('POST', API_PATHS.playerAck, body);
  } catch {
    // A late or unknown ack is `matched:false` on the daemon side anyway.
  }
}

/** Queue one command from the SSE channel and ack it once it settles. */
export function handlePlayerCommand(command: PlayerCommandEvent, arrivedAt: number): void {
  void playerQueue
    .run((ctx) => execute(command, ctx), { deadlineAt: arrivedAt + COMMAND_DEADLINE_MS })
    .then(async (result) => {
      // A discarded command is never acked: the daemon stopped waiting.
      if (result === DISCARDED) return;
      await sendAck(command.request_id, result);
    });
}
