// The DatabaseContract runner (N0a, decision h).
//
// Pure: no test runner, no Node, no filesystem. The host supplies databases
// through `ContractHooks` and receives results through `ContractReport` —
// vitest turns them into `it()`s on the desktop, and the spike's judgement
// panel renders them as rows on the phone.
//
// One fresh database per case, always cleaned up, including after a failure.
// A case that cannot run is REPORTED as skipped with a reason: a suite that
// silently runs sixteen cases here and twelve there is worse than no suite,
// because the number on the screen looks the same.

import { CONTRACT_CASES } from './cases/index.js';
import type { ContractCase, ContractDatabase, ContractHooks, ContractReport } from './types.js';

export * from './assert.js';
export * from './types.js';
export { CONTRACT_CASES } from './cases/index.js';

function runOne(c: ContractCase, db: ContractDatabase, report: ContractReport): void {
  try {
    c.run(db);
    report.pass(c.group, c.name);
  } catch (err) {
    report.fail(c.group, c.name, err);
  } finally {
    db.cleanup();
  }
}

/**
 * Run the whole contract against one host.
 *
 * `hooks.open()` must hand back a fresh, empty FILE database. `:memory:` is
 * not a valid implementation: `reopen()` on an in-memory database returns a
 * different, empty one, which would make every lock and persistence case pass
 * without testing anything.
 */
export function runDatabaseContract(hooks: ContractHooks, report: ContractReport): void {
  // Probe once, so a host without counters skips those cases without opening
  // (and then discarding) a database for each of them.
  let hasCounters = false;
  const probe = hooks.open();
  try {
    hasCounters = probe.counters !== undefined;
  } finally {
    probe.cleanup();
  }

  for (const c of CONTRACT_CASES) {
    if (c.requires === 'drizzle') {
      if (!hooks.drizzle) {
        report.skip(c.group, c.name, 'the host provides no drizzle binding');
        continue;
      }
      runOne(c, hooks.drizzle(), report);
      continue;
    }

    if (c.requires === 'counters' && !hasCounters) {
      report.skip(
        c.group,
        c.name,
        'the host cannot count prepare/finalize (better-sqlite3 owns statement lifetimes)',
      );
      continue;
    }

    runOne(c, hooks.open(), report);
  }
}
