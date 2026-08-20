// The AudioLandingContract runner (N4a, shaped like `runLibraryContract`).
//
// Pure: the host supplies landings through `AudioLandingContractHooks` and gets
// results back through a report. vitest turns them into `it()`s on the desktop;
// N4b's mobile hook adds a second host without touching a case.
//
// One fresh subject per case, always released, including after a failure: a
// case that inherited the previous one's directories would pass or fail on
// leftovers rather than on the property it names.

import type { ContractReport } from '../../../contract/types.js';
import { AUDIO_LANDING_CONTRACT_CASES } from './cases.js';
import type { AudioLandingContractCase, AudioLandingContractHooks } from './types.js';

export * from './cases.js';
export * from './types.js';

async function runOne(
  c: AudioLandingContractCase,
  hooks: AudioLandingContractHooks,
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

export async function runAudioLandingContract(
  hooks: AudioLandingContractHooks,
  report: ContractReport,
): Promise<void> {
  for (const c of AUDIO_LANDING_CONTRACT_CASES) await runOne(c, hooks, report);
}
