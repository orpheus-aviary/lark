// Driving the contract from the panel (N0b-2).
//
// The desktop turns each case into a vitest `it()`; here the same runner feeds
// a list the screen renders. Durations are recorded because they are free and
// because criterion 18 will want to know which shapes are slow — but they are
// NOT the jank measurement: that one is release-build only, per §3.2a.

import { type ContractHooks, type ContractReport, runDatabaseContract } from '@lark/core/portable';

export interface ContractRow {
  group: string;
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
  ms: number;
}

export interface ContractRun {
  rows: ContractRow[];
  passed: number;
  failed: number;
  skipped: number;
  totalMs: number;
}

export function runContract(hooks: ContractHooks): ContractRun {
  const rows: ContractRow[] = [];
  let mark = Date.now();

  const since = (): number => {
    const now = Date.now();
    const elapsed = now - mark;
    mark = now;
    return elapsed;
  };

  const report: ContractReport = {
    pass: (group, name) => rows.push({ group, name, status: 'pass', ms: since() }),
    fail: (group, name, error) =>
      rows.push({
        group,
        name,
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
        ms: since(),
      }),
    skip: (group, name, reason) =>
      rows.push({ group, name, status: 'skip', detail: reason, ms: since() }),
  };

  const started = Date.now();
  runDatabaseContract(hooks, report);
  const totalMs = Date.now() - started;

  // Also to logcat: the screen can only show what fits, and a failure's detail
  // is the whole point of running this. `adb logcat | grep CONTRACT` is how the
  // host reads a run it did not scroll through.
  for (const row of rows) {
    if (row.status === 'pass') continue;
    console.log(
      `CONTRACT ${row.status.toUpperCase()} | ${row.group} › ${row.name} | ${row.detail}`,
    );
  }
  console.log(
    `CONTRACT SUMMARY | ${rows.filter((r) => r.status === 'pass').length} passed | ${
      rows.filter((r) => r.status === 'fail').length
    } failed | ${rows.filter((r) => r.status === 'skip').length} skipped | ${totalMs}ms`,
  );

  return {
    rows,
    passed: rows.filter((r) => r.status === 'pass').length,
    failed: rows.filter((r) => r.status === 'fail').length,
    skipped: rows.filter((r) => r.status === 'skip').length,
    totalMs,
  };
}
