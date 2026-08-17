// The desktop binding of the DatabaseContract (N0a-2).
//
// better-sqlite3 is the reference implementation: if a case is wrong, it is
// wrong here first, long before anybody tries to explain a red row on a phone.
// The lifecycle group's counted cases are SKIPPED here on purpose — this host
// has no prepare/finalize to count — and the second half of this file proves
// that the skip is not hiding a runner that cannot fail.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type ContractDatabase,
  type ContractHooks,
  type ContractReport,
  type ContractSongRow,
  type DrizzleContractDatabase,
  runDatabaseContract,
} from '../portable/contract/index.js';
import * as schema from '../portable/schema.js';
import type { SqliteLike } from '../portable/sqlite.js';

interface Result {
  group: string;
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
}

function collector(): { results: Result[]; report: ContractReport } {
  const results: Result[] = [];
  return {
    results,
    report: {
      pass: (group, name) => results.push({ group, name, status: 'pass' }),
      fail: (group, name, error) =>
        results.push({
          group,
          name,
          status: 'fail',
          detail: error instanceof Error ? error.message : String(error),
        }),
      skip: (group, name, reason) => results.push({ group, name, status: 'skip', detail: reason }),
    },
  };
}

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lark-contract-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

/**
 * A file database, per the hook contract — `:memory:` would make `reopen()`
 * hand back a different, empty database and quietly pass the persistence and
 * lock cases.
 */
function openFileDatabase(): { db: ContractDatabase; raw: () => BetterSqlite3.Database } {
  const dir = freshDir();
  const path = join(dir, 'contract.db');
  let handle = new BetterSqlite3(path);

  const db: ContractDatabase = {
    get sqlite() {
      return handle;
    },
    reopen() {
      handle.close();
      handle = new BetterSqlite3(path);
      return handle;
    },
    cleanup() {
      try {
        handle.close();
      } catch {
        // Already closed by a case that reopened; nothing to do.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return { db, raw: () => handle };
}

const HOOKS: ContractHooks = {
  open: () => openFileDatabase().db,
  drizzle: (): DrizzleContractDatabase => {
    const { db, raw } = openFileDatabase();
    const orm = () => drizzle(raw(), { schema });
    return {
      ...db,
      get sqlite() {
        return db.sqlite;
      },
      insertSongViaDrizzle(row: ContractSongRow) {
        orm().insert(schema.songs).values(row).run();
      },
      inDrizzleTransaction(assertWithRaw: (sqlite: SqliteLike) => void) {
        orm().transaction(() => {
          assertWithRaw(raw());
        });
      },
    };
  },
};

const { results, report } = collector();
runDatabaseContract(HOOKS, report);

describe('database contract on better-sqlite3 (file db)', () => {
  it('ran every case exactly once', () => {
    expect(results.length).toBeGreaterThan(0);
    const seen = new Set(results.map((r) => `${r.group} › ${r.name}`));
    expect(seen.size).toBe(results.length);
  });

  for (const r of results) {
    it(`${r.group} › ${r.name}`, () => {
      if (r.status === 'skip') {
        // Skips are data, not silence: assert the runner said WHY.
        expect(r.detail, `${r.group} › ${r.name} was skipped without a reason`).toBeTruthy();
        return;
      }
      expect(r.status === 'fail' ? r.detail : null).toBeNull();
    });
  }

  it('skips exactly the counted lifecycle cases, and says why', () => {
    const skipped = results.filter((r) => r.status === 'skip');
    expect(skipped.length).toBeGreaterThan(0);
    for (const r of skipped) {
      expect(r.group).toBe('lifecycle');
      expect(r.detail).toContain('prepare/finalize');
    }
  });

  it('runs the drizzle group rather than skipping it', () => {
    const shared = results.filter((r) => r.group === 'shared connection');
    expect(shared.length).toBe(2);
    expect(shared.every((r) => r.status === 'pass')).toBe(true);
  });
});

// ─── Criterion 6: the counted cases can actually go red ──
//
// better-sqlite3 has no counters, so the lifecycle group is skipped above —
// and a skipped group proves nothing about the runner. These two adapters are
// the smallest thing that does: the same fake, once honest and once with the
// bug the real shim would have (release outside a `finally`, so an error path
// leaks). The real shim's own red/green is criterion 14, on device.

interface Counting {
  sqlite: SqliteLike;
  counters: { prepared(): number; finalized(): number };
}

function transientAdapter(raw: BetterSqlite3.Database, leakOnError: boolean): Counting {
  let prepared = 0;
  let finalized = 0;

  const call = <T>(sql: string, invoke: (st: BetterSqlite3.Statement) => T): T => {
    const st = raw.prepare(sql);
    prepared++;
    let ok = false;
    try {
      const out = invoke(st);
      ok = true;
      return out;
    } finally {
      // The honest branch releases in `finally`. The leaky one releases only
      // on the way out of a successful call — which is precisely the shape of
      // a shim that forgot the `finally`.
      if (ok || !leakOnError) finalized++;
    }
  };

  const sqlite: SqliteLike = {
    prepare(sql: string) {
      return {
        get: (...p: unknown[]) => call(sql, (st) => st.get(...p)),
        all: (...p: unknown[]) => call(sql, (st) => st.all(...p)),
        run: (...p: unknown[]) => call(sql, (st) => st.run(...p)),
      };
    },
    exec: (sql: string) => raw.exec(sql),
    pragma: (sql: string, options?: { simple?: boolean }) => raw.pragma(sql, options),
    transaction: <A extends unknown[], R>(fn: (...args: A) => R) => raw.transaction(fn),
    close: () => raw.close(),
  };

  return { sqlite, counters: { prepared: () => prepared, finalized: () => finalized } };
}

function countingHooks(leakOnError: boolean): ContractHooks {
  return {
    open(): ContractDatabase {
      const dir = freshDir();
      const path = join(dir, 'contract.db');
      let raw = new BetterSqlite3(path);
      let adapter = transientAdapter(raw, leakOnError);
      return {
        get sqlite() {
          return adapter.sqlite;
        },
        get counters() {
          return adapter.counters;
        },
        reopen() {
          raw.close();
          raw = new BetterSqlite3(path);
          adapter = transientAdapter(raw, leakOnError);
          return adapter.sqlite;
        },
        cleanup() {
          try {
            raw.close();
          } catch {
            // Already closed.
          }
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  };
}

function countedResults(hooks: ContractHooks): Result[] {
  const { results: out, report: r } = collector();
  runDatabaseContract(hooks, r);
  return out.filter((x) => x.group === 'lifecycle' && x.name.startsWith('balanced'));
}

describe('the lifecycle group can fail (criterion 6)', () => {
  it('an honest per-call-transient adapter passes all four', () => {
    const balanced = countedResults(countingHooks(false));
    expect(balanced.length).toBe(4);
    expect(balanced.filter((r) => r.status === 'pass').length).toBe(4);
  });

  it('an adapter that skips release on error paths fails the two error cases', () => {
    const balanced = countedResults(countingHooks(true));
    const failed = balanced.filter((r) => r.status === 'fail');
    expect(failed.map((r) => r.name).sort()).toEqual([
      'balanced after 1k binding errors',
      'balanced after 1k constraint errors',
    ]);
    // And the failure says what it saw, not just "false".
    expect(failed[0].detail).toContain('finalized vs prepared');
    // The happy-path cases still pass — the leak is only on error paths, which
    // is what makes it the kind of bug that ships.
    expect(balanced.filter((r) => r.status === 'pass').length).toBe(2);
  });
});
