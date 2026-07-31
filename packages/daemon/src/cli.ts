#!/usr/bin/env node

import { Command } from 'commander';
import { DAEMON_VERSION, createContext } from './context.js';
import { buildServer } from './server.js';

/**
 * Start the daemon in the foreground. M2 adds the PID lock, the local-token
 * publish and graceful shutdown; M0 is a bare listen so the GUI/CLI link can be
 * exercised end to end.
 */
async function startDaemon(): Promise<void> {
  const ctx = createContext();
  const app = buildServer(ctx);
  try {
    await app.listen({ host: ctx.config.host, port: ctx.config.port });
    ctx.logger.info({ host: ctx.config.host, port: ctx.config.port }, 'daemon listening');
  } catch (err) {
    ctx.logger.error({ err }, 'daemon failed to start');
    process.exit(1);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      ctx.logger.info({ signal }, 'shutting down');
      void app.close().then(() => process.exit(0));
    });
  }
}

const program = new Command();

program.name('lark-daemon').description('lark music daemon').version(DAEMON_VERSION);

program
  .command('daemon')
  .description('Start the daemon HTTP server')
  .action(() => startDaemon());

// `from: 'node'` is explicit so the CLI works both from plain node and from
// Electron-as-Node (ELECTRON_RUN_AS_NODE=1). Without it commander detects
// `process.versions.electron` and only strips argv[0], misreading the script
// path as the first subcommand.
program.parse(process.argv, { from: 'node' });
