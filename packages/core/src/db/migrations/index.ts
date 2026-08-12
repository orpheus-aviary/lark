// Explicit migration registry (M1-1). No directory scanning — vitest runs TS
// sources while tsc emits dist copies, and a readdir would see whichever tree
// it happens to run from. Adding a migration = new NNNN-*.ts module + one
// line here; the runner validates the list is contiguous from v1.

import * as m0001 from './0001-init.js';
import * as m0002 from './0002-sync-activation.js';

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [m0001, m0002];
