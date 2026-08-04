// The player channel (R11 / M2-11).
//
// Playback lives in the renderer — the daemon owns no audio element and no
// queue. What it owns is the CORRELATION: a CLI or agent asks for `pause`, the
// active GUI executes it, and the HTTP response waits for that GUI's ack so
// the caller learns what actually happened instead of "accepted, good luck".
//
// Every failure mode therefore has its own status, because they need different
// reactions from the caller:
//
//   409 GUI_OFFLINE    nobody is listening — start the GUI
//   502 GUI_ERROR      the GUI tried and failed — its message says why
//   504 GUI_TIMEOUT    the GUI is connected but not answering — it may be wedged
//   503 SHUTTING_DOWN  the daemon is going away — retry after restart
//
// GUI_OFFLINE covers three moments, all of which must fail FAST rather than
// wait out the ack timeout: no active connection at all, a write that fails at
// send time (the socket died between the check and the write), and a
// disconnect while the command is in flight.

import { randomUUID } from 'node:crypto';
import { getSong } from '@lark/core';
import {
  API_PATHS,
  type AckRequest,
  type GuiRegisterData,
  type GuiRegisterRequest,
  PLAYER_COMMANDS,
  PLAY_MODES,
  type PlayMode,
  type PlayerCommand,
  type PlayerCommandName,
  type PlayerStatusData,
  type PlayerStatusResponse,
  VIRTUAL_ALL_PLAYLIST_ID,
  apiPath,
  isUuidV4,
} from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { GuiCapacityError } from '../events/gui-channel.js';
import { fail, ok } from '../response.js';
import {
  InvalidRequestError,
  objectBody,
  optionalString,
  optionalUuid,
  requiredBoolean,
  requiredNumber,
  requiredSafeInteger,
  requiredString,
  requiredUuid,
} from '../validation.js';

const MESSAGE_MAX = 500;
const VERSION_MAX = 64;

/** A playlist id on the wire: a real UUID, or the virtual all list. */
function playlistId(body: Record<string, unknown>, key: string): string {
  if (body[key] === VIRTUAL_ALL_PLAYLIST_ID) return VIRTUAL_ALL_PLAYLIST_ID;
  return requiredUuid(body, key);
}

function playMode(body: Record<string, unknown>, key: string): PlayMode {
  const value = body[key];
  if (typeof value !== 'string' || !(PLAY_MODES as readonly string[]).includes(value)) {
    throw new InvalidRequestError(
      'INVALID_BODY',
      `${key} must be one of: ${PLAY_MODES.join(', ')}`,
    );
  }
  return value as PlayMode;
}

interface CommandSpec {
  /** Body fields this command accepts; anything else is a 400. */
  readonly fields: readonly string[];
  readonly build: (body: Record<string, unknown>, ctx: AppContext) => PlayerCommand;
}

/**
 * The command table IS the wire contract (M2-11): the URL carries the name and
 * the body carries exactly these fields. Only `play` verifies its target
 * exists — the GUI resolves everything else and reports failure through its
 * ack, which is what the 502 path is for.
 */
const COMMANDS: Record<PlayerCommandName, CommandSpec> = {
  play: {
    fields: ['song_id'],
    build: (body, ctx) => {
      const songId = requiredUuid(body, 'song_id');
      getSong(ctx.db, ctx.sqlite, songId); // unknown song → 404 before dispatch
      return { command: 'play', song_id: songId };
    },
  },
  'play-playlist': {
    fields: ['playlist_id', 'song_id'],
    build: (body) => {
      const songId = optionalUuid(body, 'song_id');
      const command: PlayerCommand = {
        command: 'play-playlist',
        playlist_id: playlistId(body, 'playlist_id'),
      };
      // Membership is deliberately NOT checked: the GUI decides what "start
      // here" means for a list it is about to load.
      return songId === undefined ? command : { ...command, song_id: songId };
    },
  },
  'switch-playlist': {
    fields: ['playlist_id'],
    build: (body) => ({
      command: 'switch-playlist',
      playlist_id: playlistId(body, 'playlist_id'),
    }),
  },
  pause: { fields: [], build: () => ({ command: 'pause' }) },
  resume: { fields: [], build: () => ({ command: 'resume' }) },
  next: { fields: [], build: () => ({ command: 'next' }) },
  prev: { fields: [], build: () => ({ command: 'prev' }) },
  seek: {
    fields: ['position'],
    build: (body) => ({ command: 'seek', position: requiredNumber(body, 'position', { min: 0 }) }),
  },
  mode: {
    fields: ['mode'],
    build: (body) => ({ command: 'mode', mode: playMode(body, 'mode') }),
  },
};

const REPORT_FIELDS = [
  'current_song',
  'is_playing',
  'current_time',
  'duration',
  'play_mode',
  'playlist_id',
] as const;

/** Full-shape validation: a malformed report must not enter the mirror at all. */
function parseReport(raw: unknown): PlayerStatusData {
  const body = objectBody(raw, REPORT_FIELDS);
  const song = body.current_song;
  let currentSong: PlayerStatusData['current_song'] = null;
  if (song !== null && song !== undefined) {
    const songBody = objectBody(song, ['id', 'name', 'artist']);
    currentSong = {
      id: requiredUuid(songBody, 'id'),
      name: requiredString(songBody, 'name', { maxLength: 500, allowEmpty: true }) ?? '',
      artist: optionalString(songBody, 'artist', { maxLength: 500, allowEmpty: true }) ?? '',
    };
  }

  const playlist = body.playlist_id;
  if (
    playlist !== null &&
    playlist !== undefined &&
    playlist !== VIRTUAL_ALL_PLAYLIST_ID &&
    !(typeof playlist === 'string' && isUuidV4(playlist))
  ) {
    throw new InvalidRequestError('INVALID_ID', "playlist_id must be a UUID v4, 'all', or null");
  }

  return {
    current_song: currentSong,
    is_playing: requiredBoolean(body, 'is_playing'),
    current_time: requiredNumber(body, 'current_time', { min: 0 }),
    duration: requiredNumber(body, 'duration', { min: 0 }),
    play_mode: playMode(body, 'play_mode'),
    playlist_id: (playlist as string | null | undefined) ?? null,
  };
}

export function registerPlayerRoutes(app: FastifyInstance, ctx: AppContext): void {
  // A disconnect must fail that connection's in-flight commands NOW: waiting
  // out the ack timeout would report GUI_TIMEOUT for a GUI that is plainly gone.
  ctx.guiChannel.onActiveClose((guiId) => {
    ctx.player.failFor(guiId, { kind: 'offline' });
  });

  app.post(API_PATHS.guiRegister, async (req, reply) => {
    const body = objectBody(req.body, ['pid', 'version']);
    const request: GuiRegisterRequest = {
      pid: requiredSafeInteger(body, 'pid', { min: 2 }),
      version: requiredString(body, 'version', { maxLength: VERSION_MAX }),
    };
    try {
      const data: GuiRegisterData = {
        gui_instance_id: ctx.guiChannel.register(request.pid, request.version),
      };
      return ok(reply, data);
    } catch (err) {
      if (!(err instanceof GuiCapacityError)) throw err;
      return fail(reply, 409, err.message, 'GUI_CAPACITY');
    }
  });

  app.get(API_PATHS.playerStatus, async (_req, reply) => {
    ok(reply, {
      gui_online: ctx.guiChannel.guiOnline(),
      player: ctx.player.lastReport,
      reported_at: ctx.player.reportedAt,
    } satisfies PlayerStatusResponse);
  });

  // No active-connection check: a report is a mirror update, and rejecting one
  // because the reporter is not the active GUI would just lose state.
  app.post(API_PATHS.playerReport, async (req, reply) => {
    ctx.player.lastReport = parseReport(req.body);
    ctx.player.reportedAt = Date.now();
    ok(reply, { accepted: true });
  });

  // Late or unknown request ids are ignored, not rejected: the GUI acking a
  // command that already timed out is normal, and a 4xx there would make it
  // look like the GUI misbehaved.
  app.post(API_PATHS.playerAck, async (req, reply) => {
    const body = objectBody(req.body, ['request_id', 'ok', 'message']);
    const ack: AckRequest = {
      request_id: requiredUuid(body, 'request_id'),
      ok: requiredBoolean(body, 'ok'),
      message:
        optionalString(body, 'message', { maxLength: MESSAGE_MAX, allowEmpty: true }) ?? undefined,
    };
    ok(reply, { matched: ctx.player.ack(ack.request_id, ack.ok, ack.message) });
  });

  for (const name of PLAYER_COMMANDS) {
    const spec = COMMANDS[name];
    app.post(apiPath.playerCommand(name), async (req, reply) => {
      const command = spec.build(objectBody(req.body ?? {}, spec.fields), ctx);

      const guiId = ctx.guiChannel.activeId();
      if (guiId === null) {
        return fail(reply, 409, 'no GUI is connected to execute player commands', 'GUI_OFFLINE');
      }

      const requestId = randomUUID();
      // Track BEFORE sending: the ack can arrive on another connection's turn
      // of the event loop the moment the write lands.
      const settled = ctx.player.track(requestId, guiId, ctx.ackTimeoutMs);
      if (
        !ctx.guiChannel.sendToActive({ type: 'player:command', request_id: requestId, ...command })
      ) {
        ctx.player.settle(requestId, { kind: 'offline' });
      }

      const outcome = await settled;
      switch (outcome.kind) {
        case 'ok':
          return ok(reply, { request_id: requestId });
        case 'gui-error':
          return fail(reply, 502, outcome.message, 'GUI_ERROR');
        case 'timeout':
          return fail(reply, 504, 'the GUI did not acknowledge in time', 'GUI_TIMEOUT');
        case 'offline':
          return fail(
            reply,
            409,
            'the GUI disconnected before executing the command',
            'GUI_OFFLINE',
          );
        default:
          return fail(reply, 503, 'daemon is shutting down', 'SHUTTING_DOWN');
      }
    });
  }
}
