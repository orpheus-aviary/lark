// §2.2.1's table, every row, plus the two bugs the reviews found.
//
// This is the only thing in `apps/mobile` with desktop tests, and it earns
// them: it imports nothing from React Native or Expo, and both review rounds
// found their defects in this decision rather than in the machinery around it.
// Everything else here is verified on the device, because everything else here
// needs one.

import { describe, expect, it } from 'vitest';
import { type IdentityInputs, decideIdentity } from './state';

const inputs = (over: Partial<IdentityInputs> = {}): IdentityInputs => ({
  libraryExists: true,
  committed: 'install-a',
  intent: null,
  dbInstallId: 'install-a',
  ...over,
});

describe('§2.2.1, row by row', () => {
  it('no library → fresh', () => {
    expect(
      decideIdentity(inputs({ libraryExists: false, committed: null, dbInstallId: null })).action,
    ).toBe('fresh');
  });

  it('library + matching identity on both sides → normal', () => {
    expect(decideIdentity(inputs()).action).toBe('normal');
  });

  it('library whose install_id is somebody else’s → converge', () => {
    expect(decideIdentity(inputs({ dbInstallId: 'install-b' })).action).toBe('converge');
  });

  it('library with no install_id at all → converge', () => {
    expect(decideIdentity(inputs({ dbInstallId: null })).action).toBe('converge');
  });

  it('library but no committed identity → converge', () => {
    // The restored-library signature: the database came back, the Keystore did
    // not. This is the row criterion 17 injects.
    expect(decideIdentity(inputs({ committed: null, dbInstallId: 'install-b' })).action).toBe(
      'converge',
    );
  });

  it.each(['fresh', 'converge'] as const)('an in-flight %s intent → resume, same id', (purpose) => {
    const decision = decideIdentity(inputs({ intent: { id: 'install-c', purpose } }));
    expect(decision).toMatchObject({ action: 'resume', purpose, installId: 'install-c' });
  });
});

describe('the two defects the reviews caught', () => {
  // v2 → v3. A fresh first launch that never claimed an identity leaves
  // "library, no identity" behind — and that is indistinguishable from a
  // restore. The second launch would converge and wipe the library it had just
  // created. The fix is not in this function; what this function must do is
  // keep calling that state a converge, so the sequence has no choice but to
  // claim an identity on the fresh path too.
  it('a library with no identity is a converge, never a fresh', () => {
    const decision = decideIdentity(
      inputs({ libraryExists: true, committed: null, dbInstallId: null }),
    );
    expect(decision.action).toBe('converge');
    expect(decision.action).not.toBe('fresh');
  });

  // The discriminant is the FILE. A committed id with no library is an install
  // whose data was cleared — new library, new identity. Answering with the old
  // id would let a wiped install speak for its predecessor.
  it('a leftover committed id without a library is still fresh', () => {
    expect(decideIdentity(inputs({ libraryExists: false, dbInstallId: null })).action).toBe(
      'fresh',
    );
  });

  // An intent outranks every settled row, including "everything matches".
  // Otherwise a crash between writing the intent and committing it would be
  // read as a normal boot, and the intent would sit there forever.
  it('an intent wins even when the settled state looks perfect', () => {
    expect(
      decideIdentity(inputs({ intent: { id: 'install-a', purpose: 'converge' } })).action,
    ).toBe('resume');
  });
});
