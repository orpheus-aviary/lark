// Statement lifecycle (subplan §2.2).
//
// core prepares once and reuses across rows in four hot loops and never
// finalizes anything — it has no dispose API to call. So the contract puts the
// obligation on the IMPLEMENTATION: a host must not leak under that usage.
//
// "Did not leak" is asserted by COUNTING, not by watching memory. RSS is a
// trend, and a trend cannot fail a test honestly. better-sqlite3 owns statement
// lifetimes internally and has nothing to count, so the counted cases are
// skipped on the desktop and are hard judgements on device (criterion 14) —
// which is exactly why `runDatabaseContract` reports a skip out loud instead
// of quietly running twelve cases where the phone runs sixteen.

import { check, equal, throws } from '../assert.js';
import type { ContractCase, ContractCounters, ContractDatabase } from '../types.js';
import { T0, count, migrate, seedSong } from './support.js';

const GROUP = 'lifecycle';

const INSERT_SONG =
  'INSERT INTO songs (id, name, artist, created_at, updated_at) VALUES (?, ?, ?, ?, ?)';

/** `requires: 'counters'` guarantees this; the throw is for a lying host. */
function counters(db: ContractDatabase): ContractCounters {
  if (!db.counters) throw new Error('the host declared counters and did not provide them');
  return db.counters;
}

function assertBalanced(db: ContractDatabase, what: string): void {
  const c = counters(db);
  const prepared = c.prepared();
  const finalized = c.finalized();
  check(prepared > 0, `${what}: the counters saw nothing at all`);
  equal(finalized, prepared, `${what}: finalized vs prepared`);
}

export const LIFECYCLE_CASES: readonly ContractCase[] = [
  {
    group: GROUP,
    name: 'a reused handle survives interleaving with a second statement',
    run(db) {
      const sqlite = migrate(db.sqlite);
      const insert = sqlite.prepare(INSERT_SONG);
      const read = sqlite.prepare('SELECT count(*) AS n FROM songs');

      insert.run('r1', 'one', '', T0, T0);
      equal((read.get() as { n: number }).n, 1, 'after the first');
      insert.run('r2', 'two', '', T0, T0);
      check(read.all().length === 1, 'the read handle still works');
      insert.run('r3', 'three', '', T0, T0);
      equal((read.get() as { n: number }).n, 3, 'all three landed');
    },
  },
  {
    group: GROUP,
    name: 'a failed write releases the lock immediately',
    run(db) {
      // The failure mode this rules out: a host that leaks the statement of a
      // failed write leaves an open transaction behind, and the very next
      // `BEGIN IMMEDIATE` gets SQLITE_BUSY — from itself.
      const sqlite = migrate(db.sqlite);
      seedSong(sqlite, { id: 'dup' });
      throws(() => seedSong(sqlite, { id: 'dup' }), 'a duplicate insert');

      sqlite.exec('BEGIN IMMEDIATE');
      seedSong(sqlite, { id: 'after' });
      sqlite.exec('COMMIT');
      equal(count(sqlite, 'SELECT count(*) AS n FROM songs'), 2, 'the write went through');
    },
  },
  {
    group: GROUP,
    name: 'close() then reopen() leaves the database writable',
    run(db) {
      const sqlite = migrate(db.sqlite);
      for (let i = 0; i < 200; i++) seedSong(sqlite, { id: `s${i}` });

      const reopened = db.reopen();
      equal(count(reopened, 'SELECT count(*) AS n FROM songs'), 200, 'the rows are still there');
      seedSong(reopened, { id: 'after-reopen' });
      equal(count(reopened, 'SELECT count(*) AS n FROM songs'), 201, 'and it still writes');
    },
  },
  {
    group: GROUP,
    name: 'balanced after 1k successful executions',
    requires: 'counters',
    run(db) {
      const sqlite = migrate(db.sqlite);
      const insert = sqlite.prepare(INSERT_SONG);
      // One transaction around the loop: this case measures prepare/finalize
      // pairing, not durability, and 1k separate commits would make the suite
      // slow enough that somebody eventually stops running it.
      sqlite
        .transaction(() => {
          for (let i = 0; i < 1000; i++) insert.run(`s${i}`, 'n', '', T0, T0);
        })
        .immediate();
      equal(count(sqlite, 'SELECT count(*) AS n FROM songs'), 1000, 'all 1k inserted');
      assertBalanced(db, 'after 1k successes');
    },
  },
  {
    group: GROUP,
    name: 'balanced after 1k binding errors',
    requires: 'counters',
    run(db) {
      const sqlite = migrate(db.sqlite);
      const insert = sqlite.prepare(INSERT_SONG);
      for (let i = 0; i < 1000; i++) {
        // Too few values: the host fails between prepare and execute, which is
        // the window a `finally` has to cover.
        throws(() => insert.run(`s${i}`), 'too few bound values');
      }
      equal(count(sqlite, 'SELECT count(*) AS n FROM songs'), 0, 'nothing was written');
      assertBalanced(db, 'after 1k bind errors');
    },
  },
  {
    group: GROUP,
    name: 'balanced after 1k constraint errors',
    requires: 'counters',
    run(db) {
      const sqlite = migrate(db.sqlite);
      seedSong(sqlite, { id: 'taken' });
      const insert = sqlite.prepare(INSERT_SONG);
      for (let i = 0; i < 1000; i++) {
        // Here the host fails DURING execution — a different window from the
        // bind error above, and a different `finally` in a naive shim.
        throws(() => insert.run('taken', 'n', '', T0, T0), 'a duplicate primary key');
      }
      equal(count(sqlite, 'SELECT count(*) AS n FROM songs'), 1, 'still just the one row');
      assertBalanced(db, 'after 1k constraint errors');
    },
  },
  {
    group: GROUP,
    name: 'balanced after 10k mixed calls, and the database still reopens',
    requires: 'counters',
    run(db) {
      const sqlite = migrate(db.sqlite);
      const insert = sqlite.prepare(INSERT_SONG);
      const one = sqlite.prepare('SELECT id FROM songs WHERE id = ?');
      const many = sqlite.prepare('SELECT id FROM songs LIMIT 5');

      sqlite
        .transaction(() => {
          for (let i = 0; i < 2500; i++) {
            insert.run(`s${i}`, 'n', '', T0, T0);
            one.get(`s${i}`);
            one.get('missing');
            many.all();
          }
        })
        .immediate();

      assertBalanced(db, 'after 10k mixed calls');

      const reopened = db.reopen();
      equal(count(reopened, 'SELECT count(*) AS n FROM songs'), 2500, 'the data is all there');
    },
  },
];
