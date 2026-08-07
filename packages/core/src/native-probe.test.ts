import { describe, expect, it } from 'vitest';
import { probeNativeAbi } from './native-probe.js';

describe('probeNativeAbi', () => {
  it('passes on the runtime the test suite itself runs on', async () => {
    // `just test-core` depends on `ensure-node-abi`, so the binding is on the
    // Node ABI by the time this runs. The probe INSTANTIATES a database on
    // purpose: importing the JS wrapper does not load the `.node` file, so a
    // looser check would pass even on a mismatched binding (M1-13).
    expect(await probeNativeAbi()).toEqual({ ok: true });
  });
});
