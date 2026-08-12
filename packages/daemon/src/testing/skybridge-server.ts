// Starting a real skybridge server for the e2e suites (v0.2 T6).
//
// `@orpheus-aviary/skybridge-server` is a PRIVATE package: it is not on npm
// and nothing in lark depends on it. It is resolved at RUN TIME, in this
// order, and the suites skip when none of them answer:
//
//   ① an installed `@orpheus-aviary/skybridge-server`
//   ② `LARK_SKYBRIDGE_SERVER` — a path to its built entry
//   ③ the sibling checkout, if there is one next to this repo
//
// `LARK_SYNC_E2E_REQUIRED=1` (which `just test-sync-e2e` sets) turns "not
// found" into a thrown error, so the recipe cannot be quietly green while
// testing nothing.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Only what the suites call — the package is never named in an import. */
export interface SkybridgeServerModule {
  defaultConfig(dir: string): {
    server: { host: string; port: number };
    storage: { dbPath: string; attachmentRoot: string };
    logging: { level: string; file: string | null };
  };
  openDb(opts: { path: string; requireMigrationsApplied: boolean }): { close(): void };
  applyMigrations(db: unknown): void;
  buildApp(opts: { config: unknown; logger: false }): Promise<{
    app: {
      listen(opts: { host: string; port: number }): Promise<void>;
      close(): Promise<void>;
      server: { address(): { port: number } | string | null };
    };
    db: unknown;
  }>;
  createUser(db: unknown, input: { email: string; password: string }): Promise<{ id: string }>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the sibling checkout keeps its built server, when there is one. */
const SIBLING_SERVER = join(HERE, '../../../../../skybridge/packages/server/dist/src/index.js');

export async function resolveSkybridgeServer(): Promise<SkybridgeServerModule | null> {
  const candidates = [
    '@orpheus-aviary/skybridge-server',
    process.env.LARK_SKYBRIDGE_SERVER,
    existsSync(SIBLING_SERVER) ? SIBLING_SERVER : undefined,
  ].filter((spec): spec is string => spec !== undefined && spec !== '');

  for (const spec of candidates) {
    try {
      return (await import(spec)) as SkybridgeServerModule;
    } catch {
      // Next candidate. A missing private package is the normal case.
    }
  }
  if (process.env.LARK_SYNC_E2E_REQUIRED === '1') {
    throw new Error(
      'the skybridge server could not be resolved — install @orpheus-aviary/skybridge-server, ' +
        'point LARK_SKYBRIDGE_SERVER at its built entry, or check out the sibling repo and build it',
    );
  }
  return null;
}

export interface RunningSkybridgeServer {
  baseUrl: string;
  db: unknown;
  close: () => Promise<void>;
}

export async function startSkybridgeServer(
  sb: SkybridgeServerModule,
): Promise<RunningSkybridgeServer> {
  const dir = mkdtempSync(join(tmpdir(), 'lark-sync-e2e-server-'));
  const config = sb.defaultConfig(dir);
  config.logging.file = null;
  config.logging.level = 'error';

  const initDb = sb.openDb({ path: config.storage.dbPath, requireMigrationsApplied: false });
  sb.applyMigrations(initDb);
  initDb.close();

  const built = await sb.buildApp({ config, logger: false });
  // Port 0: parallel e2e files must not fight over one number.
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const address = built.app.server.address();
  if (address === null || typeof address !== 'object') throw new Error('server did not listen');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    db: built.db,
    close: async () => {
      await built.app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
