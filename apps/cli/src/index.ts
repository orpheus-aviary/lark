#!/usr/bin/env node

import { ApiError, defaultDaemonBaseUrl } from '@lark/shared';
import { Command } from 'commander';
import { createHttpBackend } from './backend/http.js';
import { runStatus } from './commands/status.js';

const CLI_VERSION = '0.1.0';

function reportAndExit(err: unknown): never {
  if (err instanceof ApiError) {
    console.error(
      `lark: ${err.message} (HTTP ${err.status}${err.errorCode ? `, ${err.errorCode}` : ''})`,
    );
  } else {
    console.error(`lark: daemon unreachable at ${defaultDaemonBaseUrl()} — is it running?`);
    console.error(`      ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}

const program = new Command();

program.name('lark').description('lark music player CLI').version(CLI_VERSION);

program
  .command('status')
  .description('Show daemon status')
  .option('--json', 'print the raw response envelope')
  .action(async (opts: { json?: boolean }) => {
    try {
      await runStatus(createHttpBackend(), opts);
    } catch (err) {
      reportAndExit(err);
    }
  });

// See packages/daemon/src/cli.ts — `from: 'node'` keeps argv parsing correct
// when the CLI is invoked through Electron-as-Node.
program.parse(process.argv, { from: 'node' });
