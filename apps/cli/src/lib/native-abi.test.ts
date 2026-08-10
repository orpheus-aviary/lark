import { describe, expect, it } from 'vitest';
import { abiError, abiErrorMessage, inWorkspace } from './native-abi.js';

const MISMATCH = {
  ok: false as const,
  reason: 'abi-mismatch' as const,
  detail: 'NODE_MODULE_VERSION 148. This version of Node.js requires 137',
  cause: null,
};

const LOAD_FAILED = {
  ok: false as const,
  reason: 'load-failed' as const,
  detail: 'dlopen(...): image not found',
  cause: null,
};

describe('abiErrorMessage', () => {
  // The whole reason the probe returns a reason instead of a sentence: a just
  // recipe is the fix in the repo and a wild goose chase for anyone who
  // installed the published package.
  it('names a just recipe only inside the workspace', () => {
    const inRepo = abiErrorMessage(MISMATCH, { workspace: true });
    expect(inRepo).toContain('just test-core');
    expect(inRepo).not.toContain('npm i -g');
  });

  it('names npm for an installed copy', () => {
    const installed = abiErrorMessage(MISMATCH, { workspace: false });
    expect(installed).toContain('@orpheus-aviary/lark-cli');
    expect(installed).toContain('npm rebuild better-sqlite3');
    expect(installed).not.toContain('just ');
  });

  it("keeps the loader's own words in both", () => {
    for (const workspace of [true, false]) {
      expect(abiErrorMessage(MISMATCH, { workspace })).toContain('NODE_MODULE_VERSION 148');
    }
  });

  // A missing dylib is not an ABI mismatch, and telling someone to rebuild for
  // the other runtime would send them after the wrong thing.
  it('does not offer a runtime fix for a plain load failure', () => {
    const message = abiErrorMessage(LOAD_FAILED, { workspace: true });
    expect(message).toContain('image not found');
    expect(message).not.toContain('just test-core');
  });
});

describe('abiError', () => {
  it('is ABI_MISMATCH — exit 3, the environment cannot rather than the op failed', () => {
    expect(abiError(MISMATCH, { workspace: true }).code).toBe('ABI_MISMATCH');
    expect(abiError(LOAD_FAILED, { workspace: true }).code).toBe('ABI_MISMATCH');
  });
});

describe('inWorkspace', () => {
  it('finds the workspace from inside the repo', () => {
    expect(inWorkspace()).toBe(true);
  });

  it('answers false rather than throwing when there is none', () => {
    expect(inWorkspace('/nowhere/at/all/index.js')).toBe(false);
  });
});
