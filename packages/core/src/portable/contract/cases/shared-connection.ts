// drizzle and the raw handle must be ONE connection (subplan §2.3).
//
// core's `…InTx` helpers take the raw handle off the drizzle object
// (`sqliteOf`) precisely so the outbox append cannot land outside the business
// write it describes. That guarantee is worth nothing if the two are separate
// connections to the same file.
//
// The order of operations below is the whole case. "Write on one side, read it
// on the other AFTER committing" proves only that both point at the same FILE —
// two connections pass it every time. Proving ONE connection means reading
// inside the uncommitted window, where a second connection would see nothing
// (or block).

import { check, equal, throws } from '../assert.js';
import type { ContractCase, DrizzleContractDatabase } from '../types.js';
import { T0, count, migrate } from './support.js';

const GROUP = 'shared connection';

export const SHARED_CONNECTION_CASES: readonly ContractCase<DrizzleContractDatabase>[] = [
  {
    group: GROUP,
    name: 'a drizzle write joins a transaction the raw handle opened',
    requires: 'drizzle',
    run(db) {
      const sqlite = migrate(db.sqlite);

      sqlite.exec('BEGIN IMMEDIATE');
      db.insertSongViaDrizzle({
        id: 'shared-1',
        name: 'written by drizzle',
        artist: '',
        created_at: T0,
        updated_at: T0,
      });

      // Still uncommitted. A second connection could not see this row.
      equal(
        count(sqlite, 'SELECT count(*) AS n FROM songs WHERE id = ?', 'shared-1'),
        1,
        'raw sees the uncommitted drizzle write',
      );

      sqlite.exec('ROLLBACK');
      equal(
        count(sqlite, 'SELECT count(*) AS n FROM songs WHERE id = ?', 'shared-1'),
        0,
        'and the rollback took it away',
      );
    },
  },
  {
    group: GROUP,
    name: 'the raw handle joins a transaction drizzle opened, and rolls back with it',
    requires: 'drizzle',
    run(db) {
      const sqlite = migrate(db.sqlite);

      const err = throws(
        () =>
          db.inDrizzleTransaction((raw) => {
            db.insertSongViaDrizzle({
              id: 'shared-2',
              name: 'inside drizzle',
              artist: '',
              created_at: T0,
              updated_at: T0,
            });
            equal(
              count(raw, 'SELECT count(*) AS n FROM songs WHERE id = ?', 'shared-2'),
              1,
              'raw sees the uncommitted row from inside',
            );
            throw new Error('roll it back');
          }),
        'a throwing drizzle transaction',
      );
      check(err instanceof Error && err.message === 'roll it back', 'the error propagates');

      equal(
        count(sqlite, 'SELECT count(*) AS n FROM songs WHERE id = ?', 'shared-2'),
        0,
        'nothing survived the rollback',
      );
    },
  },
];
