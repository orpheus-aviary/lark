import { realpathSync } from 'node:fs';
import {
  isLlmConfigured,
  nestFingerprint,
  paths,
  realpathMissingOk,
  resolveLlmConfig,
} from '@lark/core';
import {
  API_PATHS,
  type CapabilitiesData,
  type CapabilityEndpoint,
  IMPORT_AUDIO_EXTENSIONS,
  type InstanceData,
  LOCAL_API_VERSION,
  PLAYER_COMMANDS,
  type StatusData,
  apiPath,
} from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { audioMigrationCounts } from '../migration/report.js';
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
    path: API_PATHS.instance,
    description: 'Instance identity: data-directory realpath, pid, versions',
  },
  {
    method: 'GET',
    path: API_PATHS.events,
    description: 'SSE event stream; ?role=gui&gui_id=<id> claims the GUI command channel',
  },

  // The one-time mp3 → m4a migration (0.3.0). The first two answer while the
  // library is still being converted; the third only once it is served.
  {
    method: 'GET',
    path: API_PATHS.audioMigration,
    description: 'Audio migration report: per-object outcome and backup usage',
  },
  {
    method: 'POST',
    path: API_PATHS.audioMigrationRetry,
    description: 'Re-check the machine and continue a blocked audio migration',
  },
  {
    method: 'POST',
    path: API_PATHS.audioMigrationBackupClear,
    description: 'Delete every migration backup (needs confirm: true)',
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
    path: apiPath.playlistExport(':id'),
    description: 'Export a playlist ("all" = the whole library) as a lark-playlist file',
  },
  {
    method: 'POST',
    path: API_PATHS.playlistImportPreview,
    description: 'Validate an export file and report what importing it would do',
  },
  {
    method: 'POST',
    path: API_PATHS.playlistImport,
    description: 'Import an export file in one transaction (all songs or none)',
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

  {
    method: 'POST',
    path: API_PATHS.downloadSong,
    description: 'Queue a download from a bilibili link or a keyword',
  },
  {
    method: 'POST',
    path: API_PATHS.downloadParse,
    description: 'Classify pasted input without queuing anything',
  },
  {
    method: 'POST',
    path: API_PATHS.downloadBatch,
    description: 'Queue several groups of downloads atomically',
  },
  {
    method: 'POST',
    path: API_PATHS.downloadFetchList,
    description: 'Expand a favourites folder or a collection into videos',
  },
  { method: 'POST', path: API_PATHS.downloadCancel, description: 'Cancel a download task' },
  {
    method: 'POST',
    path: API_PATHS.downloadCancelAll,
    description: 'Ask every active download task to stop; answers per task',
  },
  {
    method: 'GET',
    path: API_PATHS.downloadTasks,
    description: 'Snapshot of download tasks and batches',
  },
  {
    method: 'POST',
    path: apiPath.downloadLyrics(':id'),
    description: 'Queue a lyrics fetch for a song',
  },

  { method: 'POST', path: API_PATHS.songImport, description: 'Import local audio files' },
  {
    method: 'POST',
    path: apiPath.songRecognizeUrl(':id'),
    description: 'Preview what a URL resolves to (writes nothing)',
  },
  {
    method: 'POST',
    path: apiPath.songRedownload(':id'),
    description: "Re-download a song's audio, replacing the current file",
  },

  {
    method: 'POST',
    path: apiPath.songEnsureFile(':id'),
    description: "Download a song's audio only if it is missing",
  },

  {
    method: 'GET',
    path: API_PATHS.cacheStatus,
    description: 'Audio cache usage, what is reclaimable, and the limit',
  },
  {
    method: 'POST',
    path: API_PATHS.cacheEvict,
    description: 'Evict least-recently-used downloaded files down to the limit',
  },

  // skybridge sync (v0.2).
  {
    method: 'POST',
    path: API_PATHS.syncLogin,
    description: 'Log in to a skybridge server and bind this library to its workspace',
  },
  {
    method: 'POST',
    path: API_PATHS.syncLogout,
    description: 'Drop the sync session (the device and the binding survive)',
  },
  { method: 'POST', path: API_PATHS.syncRun, description: 'Run one sync round now' },
  {
    method: 'GET',
    path: API_PATHS.syncStatus,
    description: 'Sync state, counters, and anything waiting for a human',
  },
  {
    method: 'GET',
    path: API_PATHS.syncDevices,
    description: 'Devices registered on the sync account',
  },
  {
    method: 'POST',
    path: API_PATHS.syncRevokeDevice,
    description: 'Revoke a device on the sync account',
  },
  {
    method: 'GET',
    path: API_PATHS.syncFileOps,
    description: 'Queued and failed file effects (lyrics text is redacted)',
  },
  {
    method: 'POST',
    path: API_PATHS.syncFileOpsRetry,
    description: 'Retry failed file effects (all of them, or one by id)',
  },
  {
    method: 'POST',
    path: API_PATHS.syncFileOpsDiscard,
    description: 'Abandon one permanently failed file effect, keeping a record of it',
  },

  {
    method: 'GET',
    path: API_PATHS.conflicts,
    description: 'Unresolved edit conflicts, with both versions',
  },
  { method: 'GET', path: API_PATHS.conflictsCount, description: 'Unresolved conflict count' },
  { method: 'GET', path: apiPath.conflict(':id'), description: 'One conflict record' },
  {
    method: 'POST',
    path: apiPath.conflictResolve(':id'),
    description: 'Keep the local or the remote version (CAS on the current LWW key)',
  },
];

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /status — liveness probe. Permanently unauthenticated: the GUI and CLI
  // probe it before they can read the token file, and it is the only exemption
  // in the Bearer gate. `pid` is what lets `stop-daemon` / the GUI prove the
  // process behind the pid file really is this daemon (M2-3).
  //
  // Since M6 it also answers WHOSE daemon this is: `nest_fingerprint` +
  // `local_api_version` let a caller holding no usable token distinguish "my
  // daemon" from "another nest's daemon" instead of failing closed on both
  // (M6-19). Computed per request, like `/api/instance`'s realpath — the cost
  // is one syscall and a hash of a short string.
  app.get(API_PATHS.status, async (_req, reply) => {
    ok(
      reply,
      {
        status: 'ok',
        pid: process.pid,
        uptime: process.uptime(),
        version: ctx.version,
        nest_fingerprint: nestFingerprint(realpathMissingOk(paths.larkDir())),
        local_api_version: LOCAL_API_VERSION,
        audio_migration: audioMigrationCounts(ctx),
      } satisfies StatusData,
      'daemon is running',
    );
  });

  // GET /api/instance — authenticated identity (M4-2). `/status` proves a
  // daemon is alive; a token round-trip proves both sides HOLD the same token
  // file (still true after a whole-nest copy). Only this response ties the
  // port to a data directory, so the GUI compares `nest_dir` (both sides
  // realpath'd) before reusing a running daemon.
  app.get(API_PATHS.instance, async (_req, reply) => {
    ok(reply, {
      nest_dir: realpathSync(paths.larkDir()),
      pid: process.pid,
      version: ctx.version,
      local_api_version: LOCAL_API_VERSION,
    } satisfies InstanceData);
  });

  // The endpoint list is static; `media_tools` is not. Reading it costs
  // nothing (`snapshot` never probes) but a stale `missing` would outlive the
  // `brew install` that fixed it, so this asks for a refresh — which the
  // registry answers from cache unless the last verdict was bad AND older than
  // its floor. That makes "install ffmpeg, reopen settings" work without a
  // restart, and keeps a settings page that polls from forking processes.
  app.get(API_PATHS.capabilities, async (_req, reply) => {
    // Resolved once: `llm_available` and `llm_effective_format` are two
    // questions about the same answer, and asking twice could read the aviary
    // file twice and disagree with itself.
    const llm = resolveLlmConfig(ctx.config);
    ok(reply, {
      name: 'lark',
      version: ctx.version,
      endpoints: [...ENDPOINTS],
      media_tools: await ctx.mediaTools.refresh(),
      // The EFFECTIVE config (0.3.0 §3.6-1): a key inherited from aviary's
      // shared config is a working LLM, and a client that greyed out keyword
      // search because lark's own file is empty would be wrong about it.
      llm_available: isLlmConfigured(llm),
      audio_format: 'm4a',
      import_formats: [...IMPORT_AUDIO_EXTENSIONS],
      llm_effective_format: llm.api_format,
    } satisfies CapabilitiesData);
  });
}
