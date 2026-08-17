// The SQLite surface `@lark/core/portable` is allowed to assume (N0a).
//
// Desktop satisfies it with better-sqlite3 (see the `satisfies` in
// `db/index.ts` — the one place a real handle is created); Android will satisfy
// it with an expo-sqlite shim in N2. Everything in this file is a TYPE: the
// portable modules take `SqliteLike`, so neither implementation is named
// anywhere under `portable/` and the guard can forbid better-sqlite3 outright.
//
// The surface is the MEASURED one (subplan §1.5), not everything better-sqlite3
// offers. Adding to it costs a shim method on every future host, so a method
// gets in when core actually calls it.
//
// Deliberately OUT of scope, with reasons:
//   - `backup()`, WAL / writer / migrate locks, read-only opens, the migration
//     residue recovery: desktop-only mechanics, and the mobile database is a
//     single-process file. They stay on `BetterSqlite3.Database` in `db/`.
//   - `iterate()` / `pluck()` / `raw()` / `safeIntegers()`: core calls none of
//     them (verified by grep, N0a).
//   - Nested `transaction()` / SAVEPOINT: core uses neither, and both hosts
//     implement savepoints natively — so this contract neither tests nor
//     forbids nesting, and no implementation should artificially break it. A
//     future caller that wants nesting extends the contract FIRST (decision c2).

/**
 * `INSERT`/`UPDATE`/`DELETE` result.
 *
 * `lastInsertRowid` is `number | bigint` because better-sqlite3 says so; every
 * consumer in core wraps it in `Number()`, which is what a host returning
 * plain numbers must stay compatible with.
 */
export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/**
 * A prepared statement handle.
 *
 * LIFECYCLE CONTRACT (frozen, N0a) — the handle does NOT promise to hold a
 * native statement, and the caller has NO dispose obligation. core prepares
 * once and reuses across rows in four hot loops (`sync/apply.ts`,
 * `sync/engine.ts`, `sync/backfill.ts`, `migration/scanner.ts`) and never
 * finalizes anything, so:
 *
 *   - better-sqlite3 satisfies this as-is (it owns the statement's lifetime).
 *   - the expo-sqlite shim satisfies it as PER-CALL TRANSIENT: the handle keeps
 *     the SQL text, and every `get`/`all`/`run` does
 *     `prepareSync -> bind -> execute -> consume fully -> finally finalizeSync`.
 *     Consuming BEFORE finalizing is not an implementation detail: Expo's
 *     `executeSync()` hands back a cursor that must be read out first, so
 *     finalizing early is the shape that passes writes and breaks queries.
 *
 * "No leak" is asserted by counting prepare/finalize pairs, not by watching
 * memory — see the contract's lifecycle group.
 *
 * Bindings come in the three forms core uses: nothing, positional values
 * (`.get(id)`), or ONE object of named parameters (`migration/scanner.ts`).
 * Values are the SQLite-native set — null, number, bigint, string, bytes.
 * `unknown[]` rather than a narrower union is the same choice better-sqlite3's
 * own typings make, and narrowing it here would fail against them for the
 * named-object form; a bad value is a runtime error on both hosts.
 */
export interface SqliteStatement {
  /** The row, or `undefined` when the query matched nothing. */
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): SqliteRunResult;
}

/**
 * A transaction wrapper. Callable directly, and `.immediate()` takes the write
 * lock up front — core uses `.immediate()` everywhere but one deliberate bare
 * call (`sync/file-ops.ts`, a read-mostly journal drain).
 */
export interface SqliteTransaction<A extends unknown[], R> {
  (...args: A): R;
  immediate(...args: A): R;
}

/** Only `simple` is used: `pragma('user_version', { simple: true })`. */
export interface SqlitePragmaOptions {
  simple?: boolean;
}

/**
 * The database handle the portable modules take.
 *
 * Return types are deliberately loose (`unknown`) so that a host's more
 * specific generics remain assignable — the callers cast at the point of use,
 * exactly as they did against better-sqlite3.
 */
export interface SqliteLike {
  prepare(sql: string): SqliteStatement;
  /** Multi-statement SQL, including manual `BEGIN` / `COMMIT` / `ROLLBACK`. */
  exec(sql: string): unknown;
  /** `pragma('table_info(songs)')` -> rows; with `{ simple: true }` -> scalar. */
  pragma(sql: string, options?: SqlitePragmaOptions): unknown;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): SqliteTransaction<A, R>;
  close(): unknown;
}
