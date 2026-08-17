// Assertions for the database contract (N0a).
//
// Hand-rolled because the contract runs in two places that share no test
// runner: vitest on the desktop, and a judgement panel inside the Android
// spike. A thrown Error IS the failure protocol — `runDatabaseContract`
// catches it and hands it to the report.

export class ContractAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractAssertionError';
  }
}

export function check(condition: boolean, what: string): void {
  if (!condition) throw new ContractAssertionError(what);
}

function show(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** `Object.is`, so `NaN` matches itself and `0`/`-0` do not silently pass. */
export function equal(actual: unknown, expected: unknown, what: string): void {
  if (!Object.is(actual, expected)) {
    throw new ContractAssertionError(`${what}: expected ${show(expected)}, got ${show(actual)}`);
  }
}

/**
 * Run `fn` and return what it threw.
 *
 * Fails when nothing is thrown — which is the whole point: half these cases
 * exist to prove a host REFUSES something, and "it did not throw" has to be
 * louder than a quietly passing test.
 */
export function throws(fn: () => void, what: string): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new ContractAssertionError(`${what}: expected a throw, nothing was thrown`);
}
