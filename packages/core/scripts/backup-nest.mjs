#!/usr/bin/env node
// `just backup-nest [target]` — a safe copy of the nest (M4-14⑧).
//
// Thin wrapper: every rule lives in `backupNest` so it can be tested without
// spawning a process. Honors LARK_NEST_DIR, so a copy of a copy is possible.

import { exit } from 'node:process';
import { backupNest } from '../dist/index.js';

const target = process.argv[2];

try {
  const result = await backupNest(target === undefined ? {} : { target });
  console.log(`copied: ${result.copied.join(', ')} (+ songs.db via sqlite backup)`);
  console.log(result.nestDir);
  console.log('');
  console.log('point a daemon at it with:');
  console.log(`  set -x LARK_NEST_DIR ${result.nestDir}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  exit(1);
}
