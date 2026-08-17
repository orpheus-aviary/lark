// The DatabaseContract's vocabulary (N0a, decision h).
//
// One suite of cases, two hosts: better-sqlite3 on the desktop and the
// expo-sqlite shim on Android. The point is not that both "have SQLite" — it
// is that the same schema, the same migration chain and the same statement
// lifecycle behave identically, so a mobile bug is a mobile bug and not a
// disagreement nobody wrote down.

import type { SqliteLike } from '../sqlite.js';

/**
 * prepare/finalize counters, when the host can supply them.
 *
 * Only the shim can: better-sqlite3 owns statement lifetimes internally and
 * has nothing to count. This is why the lifecycle group is `skipped` on the
 * desktop and a HARD judgement on device — "memory did not grow" is not
 * decidable in a test; `prepared === finalized` is.
 */
export interface ContractCounters {
  prepared(): number;
  finalized(): number;
}

export interface ContractDatabase {
  readonly sqlite: SqliteLike;
  /**
   * Close the current connection and open the same physical database again.
   *
   * Load-bearing, and the reason `:memory:` is banned by the hook contract: an
   * in-memory reopen hands back a DIFFERENT, empty database, so every lock and
   * residue assertion would pass without testing anything.
   */
  reopen(): SqliteLike;
  /** Delete the physical file. Called once per case, including on failure. */
  cleanup(): void;
  readonly counters?: ContractCounters;
}

/** The subset of a song row the shared-connection cases write. */
export interface ContractSongRow {
  id: string;
  name: string;
  artist: string;
  created_at: number;
  updated_at: number;
}

export interface DrizzleContractDatabase extends ContractDatabase {
  /** Insert through drizzle's query builder, not raw SQL. */
  insertSongViaDrizzle(row: ContractSongRow): void;
  /**
   * Open a drizzle transaction and run `assertWithRaw` inside it, handing back
   * the RAW handle. Throwing from the callback must roll the transaction back.
   */
  inDrizzleTransaction(assertWithRaw: (sqlite: SqliteLike) => void): void;
}

export interface ContractHooks {
  /**
   * A fresh, EMPTY file database (no tables, `user_version = 0`). Cases that
   * need the schema run the migration chain themselves — which is what lets
   * the migration group be part of the same suite.
   */
  open(): ContractDatabase;
  /** Optional: hosts without a drizzle binding skip that group explicitly. */
  drizzle?: () => DrizzleContractDatabase;
}

/**
 * Where results go. Every case reaches exactly one of these — a case that is
 * not run is `skip`ped WITH a reason, never silently absent.
 */
export interface ContractReport {
  pass(group: string, name: string): void;
  fail(group: string, name: string, error: unknown): void;
  skip(group: string, name: string, reason: string): void;
}

/** What a case needs from the host beyond a plain handle. */
export type ContractRequirement = 'drizzle' | 'counters';

export interface ContractCase<D extends ContractDatabase = ContractDatabase> {
  readonly group: string;
  readonly name: string;
  readonly requires?: ContractRequirement;
  /** Throws to fail. Gets a database fresh from the hook. */
  run(db: D): void;
}
