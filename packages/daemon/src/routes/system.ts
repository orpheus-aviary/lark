import {
  API_PATHS,
  type CapabilitiesData,
  type CapabilityEndpoint,
  PLAYER_COMMANDS,
  type StatusData,
  apiPath,
} from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ok } from '../response.js';

const PLAYER_COMMAND_DESCRIPTIONS: Record<(typeof PLAYER_COMMANDS)[number], string> = {
  play: 'Play a specific song (waits for the GUI ack)',
  'play-playlist': 'Play a playlist, optionally starting at a song',
  'switch-playlist': 'Switch the active playlist without changing playback',
  pause: 'Pause playback',
  resume: 'Resume playback',
  next: 'Skip to the next song',
  prev: 'Go back to the previous song',
  seek: 'Seek to a position in seconds',
  mode: 'Set the play mode',
};

/**
 * Self-description for agent discovery. Hand-written on purpose — a generated
 * list could not carry descriptions — which is exactly why the coverage guard
 * (system.test.ts) diffs it against `registerAllRoutes` in both directions: an
 * endpoint that ships without an entry is invisible to an agent, and an entry
 * without an endpoint is a promise the daemon cannot keep.
 */
const ENDPOINTS: readonly CapabilityEndpoint[] = [
  { method: 'GET', path: API_PATHS.status, description: 'Daemon liveness probe (no auth)' },
  { method: 'GET', path: API_PATHS.capabilities, description: 'This endpoint list' },
  {
    method: 'GET',
    path: API_PATHS.events,
    description: 'SSE event stream; ?role=gui&gui_id=<id> claims the GUI command channel',
  },

  { method: 'GET', path: API_PATHS.songs, description: 'List songs (search, sort, paginate)' },
  { method: 'GET', path: apiPath.song(':id'), description: 'Get one song' },
  { method: 'PUT', path: apiPath.song(':id'), description: 'Update song fields and source' },
  { method: 'DELETE', path: apiPath.song(':id'), description: 'Delete a song and its files' },
  { method: 'PUT', path: apiPath.songPin(':id'), description: 'Pin or unpin a song' },

  { method: 'GET', path: API_PATHS.playlists, description: 'List playlists (virtual all first)' },
  { method: 'POST', path: API_PATHS.playlists, description: 'Create a playlist' },
  { method: 'GET', path: apiPath.playlist(':id'), description: 'Get one playlist' },
  { method: 'PUT', path: apiPath.playlist(':id'), description: 'Rename a playlist' },
  { method: 'DELETE', path: apiPath.playlist(':id'), description: 'Delete a playlist' },
  {
    method: 'GET',
    path: apiPath.playlistSongs(':id'),
    description: 'List a playlist\'s songs in order ("all" = the whole library)',
  },
  {
    method: 'POST',
    path: apiPath.playlistSongs(':id'),
    description: 'Append songs to a playlist',
  },
  {
    method: 'DELETE',
    path: apiPath.playlistSong(':id', ':songId'),
    description: 'Remove one song from a playlist',
  },
  {
    method: 'POST',
    path: apiPath.playlistReorder(':id'),
    description: 'Move a member between neighbours',
  },

  {
    method: 'GET',
    path: apiPath.audio(':id'),
    description: 'Stream song audio (Range / 206, binary)',
  },
  { method: 'GET', path: apiPath.lyrics(':id'), description: 'Get LRC lyrics (text/plain)' },
  { method: 'DELETE', path: apiPath.lyrics(':id'), description: "Delete a song's lyrics file" },

  { method: 'POST', path: API_PATHS.guiRegister, description: 'Register a GUI instance' },
  { method: 'GET', path: API_PATHS.playerStatus, description: 'Last reported player state' },
  {
    method: 'POST',
    path: API_PATHS.playerReport,
    description: 'Report player state (GUI → daemon)',
  },
  { method: 'POST', path: API_PATHS.playerAck, description: 'Acknowledge a player command' },
  ...PLAYER_COMMANDS.map((command) => ({
    method: 'POST',
    path: apiPath.playerCommand(command),
    description: PLAYER_COMMAND_DESCRIPTIONS[command],
  })),

  { method: 'GET', path: API_PATHS.config, description: 'Get the config (api_key redacted)' },
  { method: 'PATCH', path: API_PATHS.config, description: 'Patch whitelisted config fields' },
];

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /status — liveness probe. Permanently unauthenticated: the GUI and CLI
  // probe it before they can read the token file, and it is the only exemption
  // in the Bearer gate. `pid` is what lets `stop-daemon` / the GUI prove the
  // process behind the pid file really is this daemon (M2-3).
  app.get(API_PATHS.status, async (_req, reply) => {
    ok(
      reply,
      {
        status: 'ok',
        pid: process.pid,
        uptime: process.uptime(),
        version: ctx.version,
      } satisfies StatusData,
      'daemon is running',
    );
  });

  app.get(API_PATHS.capabilities, async (_req, reply) => {
    ok(reply, {
      name: 'lark',
      version: ctx.version,
      endpoints: [...ENDPOINTS],
    } satisfies CapabilitiesData);
  });
}
