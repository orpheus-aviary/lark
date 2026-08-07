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
import { type CommandContext, type GlobalFlags, withContext } from './context.js';
import { toCliError } from './lib/errors.js';
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

/** Run `body` with a resolved backend. `need` decides which one it may be. */
function withBackend(
  need: 'read' | 'write',
  body: (ctx: CommandContext) => Promise<void>,
): Promise<void> {
  return run(() => withContext(need, { flags: flags() }, body));
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
    run(async () => {
      const identity = new IdentityHandle();
      await runStatus(
        { identity: () => identity.resolve(), streams: processStreams },
        { json: flags().json },
      );
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

// See packages/daemon/src/cli.ts — `from: 'node'` keeps argv parsing correct
// when the CLI is invoked through Electron-as-Node.
program.parse(process.argv, { from: 'node' });
