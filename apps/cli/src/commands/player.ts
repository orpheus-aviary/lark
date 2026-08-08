// `lark play` and the transport controls (M6-7).
//
// Playback happens in the GUI. The CLI does not play anything: it asks the
// daemon, which forwards to the one registered GUI and waits for its ack — so
// every command here has three ways to fail that are worth telling apart, and
// the daemon already does (M2-11): 409 nobody is listening, 502 the GUI tried
// and failed, 504 the GUI is connected but not answering. They map to exit
// codes through the shared table; nothing is re-interpreted here.
//
// `play` is the ONLY command that starts things. A `pause` that boots a GUI in
// order to pause silence is not a convenience, and `now-playing` is a read —
// it reports "no GUI" rather than opening one to ask.

import type {
  ApiResponse,
  PlayMode,
  PlayerCommandAcceptedData,
  PlayerStatusResponse,
} from '@lark/shared';
import { PLAY_MODES } from '@lark/shared';
import type { CommandContext } from '../context.js';
import { CliError, usageError } from '../lib/errors.js';
import { emitEnvelope } from '../lib/output.js';
import { formatDuration } from '../lib/render.js';
import { resolvePlaylistRef, resolveSongRef } from '../lib/resolve-ref.js';
import { type GuiDeps, ensureGui, guiIsOnline } from './gui.js';

export interface PlayOptions {
  playlist?: string;
  /** Never start anything: report instead (M6-7). */
  noLaunch?: boolean;
}

/**
 * What commander hands over for `play`.
 *
 * `--no-launch` arrives as `launch: false`, NOT as `noLaunch: true` — reading
 * the flag under the name it was declared with silently disables it, which is
 * how a `--no-launch` run once opened a real window (T5 实测).
 */
export function playOptionsFrom(raw: { playlist?: string; launch?: boolean }): PlayOptions {
  return {
    ...(raw.playlist === undefined ? {} : { playlist: raw.playlist }),
    noLaunch: raw.launch === false,
  };
}

/**
 * Play something — decided WITHOUT a backend, so "play what?" is a usage error
 * rather than a daemon probe.
 */
export function assertPlayShape(songRef: string | undefined, opts: PlayOptions): void {
  if (songRef === undefined && opts.playlist === undefined) {
    throw usageError('要播放什么：给一首歌，或者用 --playlist <name|id> 播放一个歌单。');
  }
}

export async function runPlay(
  ctx: CommandContext,
  songRef: string | undefined,
  opts: PlayOptions,
  deps: GuiDeps = {},
): Promise<void> {
  assertPlayShape(songRef, opts);
  await requireGui(ctx, opts.noLaunch === true, deps);

  if (opts.playlist === undefined) {
    const songId = await resolveSongRef(ctx.backend, songRef as string);
    return report(ctx, await ctx.backend.playerCommand('play', { song_id: songId }), '已开始播放');
  }

  // A song inside a playlist is "start the list HERE", and membership is
  // deliberately not checked — the daemon does not check it either, because
  // what "start here" means is the GUI's decision (M6-7).
  const playlistId = await resolvePlaylistRef(ctx.backend, opts.playlist, { allowAll: true });
  const body: { playlist_id: string; song_id?: string } = { playlist_id: playlistId };
  if (songRef !== undefined) body.song_id = await resolveSongRef(ctx.backend, songRef);
  report(ctx, await ctx.backend.playerCommand('play-playlist', body), '已开始播放歌单');
}

/**
 * The GUI has to be there. Start one, unless we were told not to.
 *
 * `ensureGui` already begins by asking whether one is online, so the happy
 * path costs ONE probe — asking here as well would double every play command's
 * round trips to save nothing.
 */
async function requireGui(ctx: CommandContext, noLaunch: boolean, deps: GuiDeps): Promise<void> {
  if (!noLaunch) {
    await ensureGui(ctx, deps);
    return;
  }
  if (await guiIsOnline(ctx)) return;
  throw new CliError(
    'GUI_OFFLINE',
    'GUI 没有在线，而 --no-launch 禁止拉起——先手动打开 lark，或者去掉 --no-launch。',
  );
}

export interface SeekOptions {
  position: string;
}

/** `pause` / `resume` / `next` / `prev` — no arguments, no launching. */
export async function runPlayerControl(
  ctx: CommandContext,
  command: 'pause' | 'resume' | 'next' | 'prev',
): Promise<void> {
  const said: Record<typeof command, string> = {
    pause: '已暂停',
    resume: '已继续',
    next: '已切到下一首',
    prev: '已切到上一首',
  };
  report(ctx, await ctx.backend.playerCommand(command, {}), said[command]);
}

export async function runSeek(ctx: CommandContext, raw: string): Promise<void> {
  const position = Number(raw);
  if (!Number.isFinite(position) || position < 0) {
    throw usageError(`seek 需要一个 ≥ 0 的秒数，收到 ${JSON.stringify(raw)}`);
  }
  report(ctx, await ctx.backend.playerCommand('seek', { position }), `已跳到 ${position}s`);
}

export async function runMode(ctx: CommandContext, raw: string): Promise<void> {
  if (!(PLAY_MODES as readonly string[]).includes(raw)) {
    throw usageError(`播放模式只能是 ${PLAY_MODES.join(' / ')}，收到 ${JSON.stringify(raw)}`);
  }
  report(
    ctx,
    await ctx.backend.playerCommand('mode', { mode: raw as PlayMode }),
    `播放模式：${raw}`,
  );
}

function report(
  ctx: CommandContext,
  envelope: ApiResponse<PlayerCommandAcceptedData>,
  line: string,
): void {
  if (ctx.flags.json) {
    emitEnvelope(ctx.streams, envelope);
    return;
  }
  ctx.streams.out(`✓ ${line}`);
}

export async function runNowPlaying(ctx: CommandContext): Promise<void> {
  const envelope = await ctx.backend.playerStatus();
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const data = envelope.data as PlayerStatusResponse;
  if (!data.gui_online) return ctx.streams.out('GUI 没有在线（用 `lark gui` 打开）');

  const player = data.player;
  if (player === null || player.current_song === null) {
    return ctx.streams.out('GUI 在线，但还没有在播放什么');
  }
  const song = player.current_song;
  const where = `${formatDuration(player.current_time)} / ${formatDuration(player.duration)}`;
  ctx.streams.out(`${player.is_playing ? '▶' : '⏸'} ${song.name} — ${song.artist}`);
  ctx.streams.out(`${where}   模式：${player.play_mode}`);
}
