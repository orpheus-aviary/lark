#!/usr/bin/env node

// `lark` — the user-facing CLI (M6).
//
// The registry and the ONE error path live here: commands throw `CliError`,
// this file renders it (an envelope on stderr under `--json`, one line
// otherwise) and exits by the table in `lib/exit-codes.ts`. No command calls
// `process.exit`, and no command writes to stderr on its own, so the output
// contract holds by construction: exit 0 ⇔ stdout carries exactly one success
// envelope in `--json` mode.
//
// Module-graph discipline (M6-21): the static imports here reach only
// `@lark/shared` and core's zero-native subpaths. The barrel — and with it
// better-sqlite3 — is loaded dynamically, on the `--direct` branch only, so
// `lark status` cannot fail on a native module it never uses.

import { Command } from 'commander';
import { runCacheEvict, runCacheStatus } from './commands/cache.js';
import { type DaemonCommandDeps, runDaemonStart, runStopDaemon } from './commands/daemon.js';
import { assertDownloadShape, runDownload, runSongsRedownload } from './commands/download.js';
import { runGui } from './commands/gui.js';
import { runLyricsDelete, runLyricsRedownload } from './commands/lyrics.js';
import {
  assertPlayShape,
  playOptionsFrom,
  runMode,
  runNowPlaying,
  runPlay,
  runPlayerControl,
  runSeek,
} from './commands/player.js';
import {
  runPlaylistAdd,
  runPlaylistCreate,
  runPlaylistDelete,
  runPlaylistList,
  runPlaylistRemove,
  runPlaylistRename,
  runPlaylistReorder,
  runPlaylistSongs,
} from './commands/playlist.js';
import {
  runSongsDelete,
  runSongsEdit,
  runSongsGet,
  runSongsList,
  runSongsPin,
} from './commands/songs.js';
import { runStatus } from './commands/status.js';
import { runPlaylistExport, runPlaylistImport } from './commands/transfer.js';
import { runUrlGet, runUrlRecognize, runUrlSet } from './commands/url.js';
import { type CommandContext, type GlobalFlags, withContext } from './context.js';
import { CliError, toCliError } from './lib/errors.js';
import { exitCodeFor } from './lib/exit-codes.js';
import { IdentityHandle } from './lib/identity.js';
import { emitError, processStreams } from './lib/output.js';
import { CLI_VERSION } from './version.js';

const program = new Command();

interface GlobalOptions {
  json?: boolean;
  direct?: boolean;
  yes?: boolean;
}

function flags(): GlobalFlags {
  const opts = program.opts<GlobalOptions>();
  return { json: opts.json === true, direct: opts.direct === true, yes: opts.yes === true };
}

/** Run a command body, rendering and exiting on the one error path. */
async function run(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    const cliError = toCliError(err);
    emitError(processStreams, cliError, { json: program.opts<GlobalOptions>().json === true });
    process.exit(exitCodeFor(cliError.code));
  }
}

interface BackendOptions {
  /**
   * Argument-shape rules, run BEFORE the daemon is probed: a command that
   * cannot be obeyed no matter what is listening should say so (exit 2)
   * rather than send the user off to start a daemon that would refuse it for
   * the same reason (exit 4).
   */
  precheck?: () => void;
  /** May this command start a daemon? `play` and `gui` only (M6-2). */
  canLaunch?: boolean;
}

/** Run `body` with a resolved backend. `need` decides which one it may be. */
function withBackend(
  need: 'read' | 'write' | 'daemon',
  body: (ctx: CommandContext) => Promise<void>,
  options: BackendOptions = {},
): Promise<void> {
  return run(async () => {
    options.precheck?.();
    await withContext(
      need,
      {
        flags: flags(),
        ...(options.canLaunch === undefined ? {} : { canLaunch: options.canLaunch }),
      },
      body,
    );
  });
}

/**
 * The management commands take no backend at all — they are about the daemon
 * PROCESS — but they still refuse `--direct`, which claims the opposite
 * (M6-22).
 */
function withIdentity(body: (deps: DaemonCommandDeps) => Promise<void>): Promise<void> {
  return run(async () => {
    const current = flags();
    if (current.direct) {
      throw new CliError('USAGE_ERROR', '这个命令管理的是 daemon 进程本身，不接受 --direct。');
    }
    await body({ identity: new IdentityHandle(), streams: processStreams, json: current.json });
  });
}

program
  .name('lark')
  .description('lark music player CLI')
  .version(CLI_VERSION)
  // Global, because every command answers the same way: `--json` is what an
  // agent passes once, not per subcommand.
  .option('--json', 'machine-readable output: one envelope on stdout, or one on stderr')
  .option('--direct', 'open the local library in this process instead of talking to the daemon')
  .option('--yes', 'assume yes for confirmations (required outside a TTY, and in --json mode)');

program
  .command('status')
  .description('Report whether OUR daemon is running, and refuse to guess when it is not')
  .action(() =>
    withIdentity((deps) =>
      runStatus(
        { identity: () => deps.identity.resolve(), streams: deps.streams },
        {
          json: deps.json,
        },
      ),
    ),
  );

// ─── daemon lifecycle ──────────────────────────────────

program
  .command('daemon')
  .description('Start the daemon if it is not already running (idempotent)')
  .action(() => withIdentity((deps) => runDaemonStart(deps)));

program
  .command('stop-daemon')
  .description('Stop OUR daemon, after proving it is ours (idempotent)')
  .action(() => withIdentity((deps) => runStopDaemon(deps)));

// ─── playback ──────────────────────────────────────────

program
  .command('play [song]')
  .description('Play a song, or a playlist with --playlist (starts the GUI if needed)')
  .option('--playlist <name|id>', 'play this playlist; with [song], start there')
  .option('--no-launch', 'never start a daemon or a GUI — report instead')
  .action((songRef: string | undefined, raw: { playlist?: string; launch?: boolean }) => {
    // commander stores `--no-launch` as `launch: false`, so the translation is
    // explicit and tested (see `playOptionsFrom`).
    const opts = playOptionsFrom(raw);
    return withBackend('daemon', (ctx) => runPlay(ctx, songRef, opts), {
      precheck: () => assertPlayShape(songRef, opts),
      canLaunch: !opts.noLaunch,
    });
  });

for (const control of ['pause', 'resume', 'next', 'prev'] as const) {
  program
    .command(control)
    .description(`Tell the GUI to ${control}`)
    .action(() => withBackend('daemon', (ctx) => runPlayerControl(ctx, control)));
}

program
  .command('seek <seconds>')
  .description('Jump to a position in the current song')
  .action((seconds: string) => withBackend('daemon', (ctx) => runSeek(ctx, seconds)));

program
  .command('mode <mode>')
  .description('Set the play mode: sequential | repeat-one | repeat-all | shuffle')
  .action((mode: string) => withBackend('daemon', (ctx) => runMode(ctx, mode)));

program
  .command('now-playing')
  .description('What the GUI is playing right now (never starts anything)')
  .action(() => withBackend('daemon', (ctx) => runNowPlaying(ctx)));

program
  .command('gui')
  .description('Open the lark window, starting a daemon first if there is none')
  .action(() => withBackend('daemon', (ctx) => runGui(ctx), { canLaunch: true }));

// ─── download ──────────────────────────────────────────

program
  .command('download [input]')
  .description('Download a link or a keyword; a favourites / collection link expands into a batch')
  .option('--batch <file>', 'read one input per line from a file, or `-` for stdin')
  .option('--playlist <name|id>', 'put everything into this playlist')
  // Tri-state on purpose: absent means "the default for this shape" — a single
  // input waits, a batch does not.
  .option('--wait', 'follow until it finishes (default for a single input)')
  .option('--no-wait', 'return as soon as it is queued')
  .option('--allow-partial', 'proceed even when the list only came back partially')
  .action((input: string | undefined, opts) =>
    withBackend('daemon', (ctx) => runDownload(ctx, input, opts), {
      precheck: () => assertDownloadShape(input, opts),
    }),
  );

// ─── songs ─────────────────────────────────────────────

const songs = program.command('songs').description('Browse and edit the library');

songs
  .command('list')
  .description('List songs')
  .option('--search <text>', 'filter by name or artist')
  .option('--sort <field>', 'name | artist | created_at')
  .option('--order <dir>', 'asc | desc')
  .option('--limit <n>', 'page size')
  .option('--offset <n>', 'page offset')
  .action((opts) => withBackend('read', (ctx) => runSongsList(ctx, opts)));

songs
  .command('search <keyword>')
  .description('Shorthand for `songs list --search`')
  .action((keyword: string) =>
    withBackend('read', (ctx) => runSongsList(ctx, { search: keyword })),
  );

songs
  .command('get <name|id>')
  .description('Show one song')
  .action((ref: string) => withBackend('read', (ctx) => runSongsGet(ctx, ref)));

songs
  .command('edit <name|id>')
  .description('Edit local fields (use `songs url` for the source link)')
  .option('--name <text>')
  .option('--artist <text>')
  .option('--lyrics-offset <seconds>')
  .option('--duration <seconds>')
  .action((ref: string, opts) => withBackend('write', (ctx) => runSongsEdit(ctx, ref, opts)));

songs
  .command('delete <name|id...>')
  .description('Delete songs and their files (asks first)')
  .action((refs: string[]) => withBackend('write', (ctx) => runSongsDelete(ctx, refs)));

songs
  .command('pin <name|id>')
  .description('Protect a song from cache eviction')
  .action((ref: string) => withBackend('write', (ctx) => runSongsPin(ctx, ref, true)));

songs
  .command('unpin <name|id>')
  .description('Allow a song to be evicted again')
  .action((ref: string) => withBackend('write', (ctx) => runSongsPin(ctx, ref, false)));

songs
  .command('redownload <name|id>')
  .description("Fetch this song's audio again, replacing what is on disk")
  .option('--wait', 'follow until it finishes (the default)')
  .option('--no-wait', 'return as soon as it is queued')
  .action((ref: string, opts) =>
    withBackend('daemon', (ctx) => runSongsRedownload(ctx, ref, opts)),
  );

// ─── songs url ─────────────────────────────────────────

const url = songs.command('url').description('The source link a song can be re-downloaded from');

url
  .command('get <name|id>')
  .description('Show the stored link and source key')
  .action((ref: string) => withBackend('read', (ctx) => runUrlGet(ctx, ref)));

url
  .command('set <name|id> <url>')
  .description('Store a link (the daemon normalises it online); pass "" to clear it')
  .action((ref: string, value: string) =>
    withBackend('daemon', (ctx) => runUrlSet(ctx, ref, value)),
  );

url
  .command('recognize <name|id> [url]')
  .description('Preview what a link resolves to; without [url], re-checks the stored one')
  .option('--save', 'store the result instead of only showing it')
  .action((ref: string, value: string | undefined, opts) =>
    withBackend('daemon', (ctx) => runUrlRecognize(ctx, ref, value, opts)),
  );

// ─── lyrics ────────────────────────────────────────────

const lyrics = program.command('lyrics').description('Per-song lyrics files');

lyrics
  .command('redownload <name|id>')
  .description('Search the lyrics providers again for this song')
  .option('--wait', 'follow until it finishes (the default)')
  .option('--no-wait', 'return as soon as it is queued')
  .action((ref: string, opts) =>
    withBackend('daemon', (ctx) => runLyricsRedownload(ctx, ref, opts)),
  );

lyrics
  .command('delete <name|id>')
  .description("Delete this song's lyrics file (asks first)")
  .action((ref: string) => withBackend('write', (ctx) => runLyricsDelete(ctx, ref)));

// ─── playlist ──────────────────────────────────────────

const playlist = program.command('playlist').description('Manage playlists');

playlist
  .command('list')
  .description('List playlists')
  .action(() => withBackend('read', (ctx) => runPlaylistList(ctx)));

playlist
  .command('songs <name|id>')
  .description('List a playlist\'s songs in order ("all" = the whole library)')
  .action((ref: string) => withBackend('read', (ctx) => runPlaylistSongs(ctx, ref)));

playlist
  .command('create <name>')
  .description('Create a playlist')
  .action((name: string) => withBackend('write', (ctx) => runPlaylistCreate(ctx, name)));

playlist
  .command('rename <name|id> <new-name>')
  .description('Rename a playlist')
  .action((ref: string, name: string) =>
    withBackend('write', (ctx) => runPlaylistRename(ctx, ref, name)),
  );

playlist
  .command('delete <name|id>')
  .description('Delete a playlist, keeping its songs (asks first)')
  .action((ref: string) => withBackend('write', (ctx) => runPlaylistDelete(ctx, ref)));

playlist
  .command('add <playlist> <song...>')
  .description('Append songs to a playlist')
  .action((ref: string, songRefs: string[]) =>
    withBackend('write', (ctx) => runPlaylistAdd(ctx, ref, songRefs)),
  );

playlist
  .command('remove <playlist> <song>')
  .description('Remove one song from a playlist')
  .action((ref: string, songRef: string) =>
    withBackend('write', (ctx) => runPlaylistRemove(ctx, ref, songRef)),
  );

playlist
  .command('reorder <playlist> <song>')
  .description('Move a song next to another one')
  .option('--before <song>', 'place it before this song')
  .option('--after <song>', 'place it after this song')
  .action((ref: string, songRef: string, opts) =>
    withBackend('write', (ctx) => runPlaylistReorder(ctx, ref, songRef, opts)),
  );

playlist
  .command('export <name|id>')
  .description('Write a playlist to a .lark-playlist.json file')
  .requiredOption('-o, --output <path>', 'target file, or an existing directory')
  .action((ref: string, opts) => withBackend('read', (ctx) => runPlaylistExport(ctx, ref, opts)));

playlist
  .command('import <file>')
  .description('Import a .lark-playlist.json file (previews first, then asks)')
  .option('--to <playlist>', 'import into an existing playlist ("all" = library only)')
  .option('--new <name>', 'import into a new playlist with this name')
  .action((file: string, opts) =>
    withBackend('write', (ctx) => runPlaylistImport(ctx, file, opts)),
  );

// ─── cache ─────────────────────────────────────────────

const cache = program.command('cache').description('Audio cache usage and eviction');

cache
  .command('status')
  .description('How much audio is on disk, and how much of it is reclaimable')
  .action(() => withBackend('read', (ctx) => runCacheStatus(ctx)));

cache
  .command('evict')
  .description('Delete least-recently-used downloaded audio down to the limit (asks first)')
  .action(() => withBackend('write', (ctx) => runCacheEvict(ctx)));

// See packages/daemon/src/cli.ts — `from: 'node'` keeps argv parsing correct
// when the CLI is invoked through Electron-as-Node.
program.parse(process.argv, { from: 'node' });
