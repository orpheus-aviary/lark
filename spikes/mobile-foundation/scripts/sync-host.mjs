// HOST script (Node, desktop) — a real skybridge server for criterion 22.
//
// Criterion 22 asks whether the skybridge SDK works from React Native at all:
// `login` / `refresh` / `pullChanges` / `pushChanges` are the four hard gates.
// Pointing them at the production server would make a platform question depend
// on someone else's uptime and would put spike junk in a real workspace, so this
// starts the same server the desktop e2e suites use, on a throwaway database.
//
//   node scripts/sync-host.mjs          # or: just spike-mobile-sync-host
//
// The device reaches it at http://localhost:8097 through `adb reverse`, which
// this script sets up — over USB, so it keeps working when Wi-Fi is off for
// criterion 23's cellular pass. Plaintext HTTP, spike only (decision f).
//
// `@orpheus-aviary/skybridge-server` is PRIVATE and nothing here depends on it:
// it is resolved at run time from an install, from `LARK_SKYBRIDGE_SERVER`, or
// from the sibling checkout — the same order `packages/daemon/src/testing/
// skybridge-server.ts` uses, re-stated rather than imported because the spike
// may not reach into `@lark/daemon`.
//
// Coordinates and credentials land in `.runtime/skybridge-host.json`, which
// `probe-host.mjs` serves to the device alongside the network fixtures.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.SKYBRIDGE_PORT ?? 8097);
const RUNTIME_DIR = fileURLToPath(new URL('../.runtime/', import.meta.url));
const OUT = `${RUNTIME_DIR}skybridge-host.json`;
const ADB = `${process.env.ANDROID_HOME ?? '/opt/homebrew/share/android-commandlinetools'}/platform-tools/adb`;

const SIBLING = fileURLToPath(
  new URL('../../../../skybridge/packages/server/dist/src/index.js', import.meta.url),
);

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

async function resolveServer() {
  const candidates = [
    '@orpheus-aviary/skybridge-server',
    process.env.LARK_SKYBRIDGE_SERVER,
    existsSync(SIBLING) ? SIBLING : undefined,
  ].filter((spec) => spec !== undefined && spec !== '');

  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      log(`server resolved from ${spec}`);
      return mod;
    } catch (err) {
      log(`  ${spec}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    }
  }
  throw new Error(
    'no skybridge server — install @orpheus-aviary/skybridge-server, set LARK_SKYBRIDGE_SERVER, ' +
      'or build the sibling checkout',
  );
}

const sb = await resolveServer();

const dir = mkdtempSync(join(tmpdir(), 'lark-spike-skybridge-'));
const config = sb.defaultConfig(dir);
config.server.host = '127.0.0.1';
config.server.port = PORT;
config.logging.file = null;
config.logging.level = 'error';

const initDb = sb.openDb({ path: config.storage.dbPath, requireMigrationsApplied: false });
sb.applyMigrations(initDb);
initDb.close();

const built = await sb.buildApp({ config, logger: false });
await built.app.listen({ host: config.server.host, port: config.server.port });

// A fresh account per run: the device's own login is what is being tested, and
// a leftover account would let a stale binding pass for a working one.
const email = `spike-${Date.now()}@lark.invalid`;
const password = 'spike-password-n0b4';
await sb.createUser(built.db, { email, password });

mkdirSync(RUNTIME_DIR, { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      startedAt: Date.now(),
      /** What the DEVICE uses — loopback through `adb reverse`, not a LAN address. */
      baseUrl: `http://localhost:${PORT}`,
      /** What the desktop uses (probe-host's nudge, for the SSE half). */
      hostBaseUrl: `http://127.0.0.1:${PORT}`,
      email,
      password,
      /** `_test` is on the server's allowed-tool list; `lark` is the product's. */
      workspaceTool: '_test',
      workspaceName: 'mobile-spike',
      dbDir: dir,
    },
    null,
    2,
  ),
  'utf-8',
);

try {
  await execFileAsync(ADB, ['reverse', `tcp:${PORT}`, `tcp:${PORT}`]);
  log(`adb reverse tcp:${PORT} → the device sees http://localhost:${PORT}`);
} catch (err) {
  log(`adb reverse failed (device not attached?): ${err instanceof Error ? err.message : err}`);
}

log(`skybridge server on ${config.server.host}:${PORT}, storage in ${dir}`);
log(`account ${email} / ${password} — written to ${OUT}`);
log('ctrl-c to stop; the database is deleted on the way out');

const shutdown = async () => {
  log('closing');
  await built.app.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  rmSync(OUT, { force: true });
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
