#!/usr/bin/env node
// Interactive one-shot Go → schema v1 migration (M1-7). `just migrate-go`
// runs this after ensure-node-abi + build-core. Honors LARK_NEST_DIR — the M1
// acceptance runs against a COPY of the real nest, never the original.

import { exit, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import BetterSqlite3 from 'better-sqlite3';
import { createConsoleLogger, migrateFromGoDb, paths } from '../dist/index.js';

const dbPath = paths.dbPath();

let overview;
try {
  const peek = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  try {
    const n = (t) => peek.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
    overview = {
      user_version: peek.pragma('user_version', { simple: true }),
      songs: n('songs'),
      playlists: n('playlists'),
      memberships: n('playlist_songs'),
    };
  } finally {
    peek.close();
  }
} catch (err) {
  console.error(`cannot open ${dbPath}: ${err instanceof Error ? err.message : err}`);
  exit(1);
}

console.log(`source library : ${dbPath}`);
console.log(`user_version   : ${overview.user_version}`);
console.log(`songs          : ${overview.songs}`);
console.log(`playlists      : ${overview.playlists} (the is_system 'all' row is dropped)`);
console.log(`memberships    : ${overview.memberships} (members of 'all' are dropped)`);
console.log('');
console.log('A consistent backup is taken first. The Go app can NO LONGER open the');
console.log('library afterwards — its real migration date is your call (M1-7).');

const rl = createInterface({ input: stdin, output: stdout });
const answer = (await rl.question('Migrate to schema v1? [y/N] ')).trim().toLowerCase();
rl.close();
if (answer !== 'y') {
  console.log('aborted — nothing was touched.');
  exit(1);
}

try {
  const result = await migrateFromGoDb(dbPath, { logger: createConsoleLogger('migrate-go') });
  if (result.already_migrated) {
    console.log(
      `already migrated — songs=${result.songs} playlists=${result.playlists} memberships=${result.memberships}`,
    );
    exit(0);
  }
  console.log('');
  console.log('migration complete:');
  console.log(`  songs       : ${result.songs}`);
  console.log(`  playlists   : ${result.playlists}`);
  console.log(`  memberships : ${result.memberships}`);
  console.log(`  elapsed     : ${result.elapsed_ms}ms`);
  console.log(`  backup      : ${result.backup_path}`);
  console.log('');
  console.log('rollback: stop everything, then copy the backup back over songs.db —');
  console.log(`  cp '${result.backup_path}' '${dbPath}'`);
} catch (err) {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  console.error(`migration failed (${name}): ${message}`);
  console.error('the source library was not modified (fail-closed).');
  exit(1);
}
