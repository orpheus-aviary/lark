// ABI canary (T1): instantiating a real Database is the only load test that
// actually exercises the compiled .node binding — keep this even after the
// real db tests land, so an ABI mismatch fails loudly and early.
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('better-sqlite3 smoke', () => {
  it('loads the native binding and round-trips a value', () => {
    const sqlite = new Database(':memory:');
    try {
      const row = sqlite.prepare('SELECT 1 + 1 AS two').get() as { two: number };
      expect(row.two).toBe(2);
    } finally {
      sqlite.close();
    }
  });
});
