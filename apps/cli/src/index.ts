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
import { runStatus } from './commands/status.js';
import { toCliError } from './lib/errors.js';
import { exitCodeFor } from './lib/exit-codes.js';
import { IdentityHandle } from './lib/identity.js';
import { emitError, processStreams } from './lib/output.js';
import { CLI_VERSION } from './version.js';

interface GlobalOptions {
  json?: boolean;
}

/** Run a command body, rendering and exiting on the one error path. */
async function run(opts: GlobalOptions, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    const cliError = toCliError(err);
    emitError(processStreams, cliError, { json: opts.json === true });
    process.exit(exitCodeFor(cliError.code));
  }
}

const program = new Command();

program
  .name('lark')
  .description('lark music player CLI')
  .version(CLI_VERSION)
  // Global, because every command answers the same way: `--json` is what an
  // agent passes once, not per subcommand.
  .option('--json', 'machine-readable output: one envelope on stdout, or one on stderr');

program
  .command('status')
  .description('Report whether OUR daemon is running, and refuse to guess when it is not')
  .action(async () => {
    const opts = program.opts<GlobalOptions>();
    await run(opts, async () => {
      const identity = new IdentityHandle();
      await runStatus(
        { identity: () => identity.resolve(), streams: processStreams },
        { json: opts.json === true },
      );
    });
  });

// See packages/daemon/src/cli.ts — `from: 'node'` keeps argv parsing correct
// when the CLI is invoked through Electron-as-Node.
program.parse(process.argv, { from: 'node' });
