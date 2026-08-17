// Transactions: `.immediate()`, the one bare call, rollback on throw, and the
// manual BEGIN/COMMIT/ROLLBACK the migration runner and the outbox writers use.
//
// Nesting and SAVEPOINT are deliberately absent (decision c2): core uses
// neither, both hosts implement them, and a contract that tested them would be
// promising something nobody asked for.

import { check, equal, throws } from '../assert.js';
import type { ContractCase } from '../types.js';
import { T0, count, migrate, seedSong } from './support.js';

const GROUP = 'transactions';

export const TRANSACTION_CASES: readonly ContractCase[] = [
  {
    group: GROUP,
    name: 'transaction().immediate() commits',
    run(db) {
      const sqlite = migrate(db.sqlite);
      sqlite
        .transaction(() => {
          seedSong(sqlite, { id: 'tx-1' });
          seedSong(sqlite, { id: 'tx-2' });
        })
        .immediate();
      equal(count(sqlite, 'SELECT count(*) AS n FROM songs'), 2, 'both rows committed');
    },
  },
  {
    group: GROUP,
    name: 'a transaction called bare commits too',
    run(db) {
      // `sync/file-ops.ts` drains its journal through a bare call, so this is
      // not a theoretical shape.
      const sqlite = migrate(db.sqlite);
      sqlite.transaction(() => seedSong(sqlite, { id: 'bare' }))();
      equal(count(sqlite, 'SELECT count(*) AS n FROM songs'), 1, 'bare call committed');
    },
  },
  {
    group: GROUP,
    name: 'arguments and the return value pass through',
    run(db) {
      const sqlite = migrate(db.sqlite);
      const returned = sqlite
        .transaction((id: string, name: string) => {
          seedSong(sqlite, { id, name });
          return `${id}:${name}`;
        })
        .immediate('tx-args', 'a name');
      equal(returned, 'tx-args:a name', 'return value');
      equal(count(sqlite, 'SELECT count(*) AS n FROM songs'), 1, 'the write happened');
    },
  },
  {
    group: GROUP,
    name: 'a throw rolls the whole transaction back and propagates',
    run(db) {
      const sqlite = migrate(db.sqlite);
      seedSong(sqlite, { id: 'before' });

      const err = throws(
        () =>
          sqlite
            .transaction(() => {
              seedSong(sqlite, { id: 'doomed-1' });
              seedSong(sqlite, { id: 'doomed-2' });
              throw new Error('rollback me');
            })
            .immediate(),
        'a throwing transaction',
      );
      check(err instanceof Error && err.message === 'rollback me', 'the original error propagates');

      equal(count(sqlite, 'SELECT count(*) AS n FROM songs'), 1, 'only the pre-existing row');
    },
  },
  {
    group: GROUP,
    name: 'manual BEGIN / COMMIT through the multi-statement runner',
    run(db) {
      const sqlite = migrate(db.sqlite);
      sqlite.exec('BEGIN');
      seedSong(sqlite, { id: 'manual' });
      sqlite.exec('COMMIT');
      equal(count(sqlite, 'SELECT count(*) AS n FROM songs'), 1, 'committed');
    },
  },
  {
    group: GROUP,
    name: 'manual BEGIN / ROLLBACK through the multi-statement runner',
    run(db) {
      // This is exactly `applyForwardMigrations`' failure path.
      const sqlite = migrate(db.sqlite);
      sqlite.exec('BEGIN');
      seedSong(sqlite, { id: 'undone' });
      sqlite.exec('ROLLBACK');
      equal(count(sqlite, 'SELECT count(*) AS n FROM songs'), 0, 'rolled back');
    },
  },
  {
    group: GROUP,
    name: 'a BEGIN IMMEDIATE write is durable once committed',
    run(db) {
      const sqlite = migrate(db.sqlite);
      sqlite.exec('BEGIN IMMEDIATE');
      sqlite
        .prepare('INSERT INTO local_metadata (key, value) VALUES (?, ?)')
        .run('in_flight', String(T0));
      sqlite.exec('COMMIT');

      const reopened = db.reopen();
      equal(
        count(reopened, "SELECT count(*) AS n FROM local_metadata WHERE key = 'in_flight'"),
        1,
        'survives a reopen',
      );
    },
  },
];
