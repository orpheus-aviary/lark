// The LibraryContract runner (N1g, shaped like `runDatabaseContract`).
//
// Pure: the host supplies libraries through `LibraryContractHooks` and gets
// results back through a report. vitest turns them into `it()`s on the desktop
// — once over the daemon's HTTP routes and once over the CLI's in-process
// backend — and N2's mobile client will add a third hook without touching a
// case.
//
// One fresh library per case, always released, including after a failure: a
// case that inherited the previous one's rows would pass or fail on ordering.

import type { ContractReport } from '../../contract/types.js';
import { LIBRARY_CONTRACT_CASES } from './cases.js';
import type { LibraryContractCase, LibraryContractHooks } from './types.js';

export * from './cases.js';
export * from './types.js';

async function runOne(
  c: LibraryContractCase,
  hooks: LibraryContractHooks,
  report: ContractReport,
): Promise<void> {
  const subject = await hooks.open();
  try {
    await c.run(subject);
    report.pass(c.group, c.name);
  } catch (err) {
    report.fail(c.group, c.name, err);
  } finally {
    await hooks.close(subject);
  }
}

export async function runLibraryContract(
  hooks: LibraryContractHooks,
  report: ContractReport,
): Promise<void> {
  for (const c of LIBRARY_CONTRACT_CASES) await runOne(c, hooks, report);
}
