// `SqliteLike` over expo-sqlite (N0b-2).
//
// PER-CALL TRANSIENT, per the lifecycle contract frozen in N0a: the handle
// returned by `prepare()` keeps the SQL text and nothing else, and every
// `get`/`all`/`run` does
//
//     prepareSync -> executeSync -> consume fully -> finally finalizeSync
//
// Consuming before finalizing is not a style choice. Expo's `executeSync()`
// hands back a cursor that still has to be read; finalizing first is the shape
// that passes every write test and breaks every query (subplan E8, and the
// same reason the drizzle patch is written the way it is).
//
// core reuses prepared handles across rows in four hot loops and never
// disposes anything, so re-preparing per call is what makes that safe here.
// What it costs is measured, not assumed — criteria 18 and R5.

import type { SqliteLike, SqliteRunResult, SqliteStatement } from '@lark/core/portable';
import type { SQLiteBindParams, SQLiteDatabase } from 'expo-sqlite';

/** Injected by the contract host so the lifecycle group has a hard judgement. */
export interface ShimCounters {
  prepared: number;
  finalized: number;
}

export interface ShimOptions {
  counters?: ShimCounters;
  /**
   * Skip the release on error paths — the bug this shim exists to not have
   * (criterion 6's fake-leaky adapter, re-run here on the device per criterion
   * 14). A suite whose hard judgement has never been seen to fail is a suite
   * nobody has tested.
   */
  leakOnError?: boolean;
}

/**
 * Named parameters, translated.
 *
 * core writes better-sqlite3's dialect: `@object_key` in the SQL, a BARE key in
 * the object (`insert.run({ object_key, … })`). expo-sqlite wants the sigil in
 * the key (`{ $value: … }`). Left untranslated, every named-parameter write in
 * core fails on Android — and `migration/scanner.ts` is nothing but named
 * parameters.
 *
 * The sigil is read off the SQL rather than guessed, because all three of
 * `@x` / `:x` / `$x` are legal and core happens to use `@`.
 */
function namedParamSigils(sql: string): Map<string, string> {
  // Strip single-quoted literals FIRST. `json_extract(payload,
  // '$.updated_at_ms')` would otherwise register a parameter called
  // `updated_at_ms` that nobody ever binds — and `sync/rebase.ts` is full of
  // exactly that shape.
  const withoutLiterals = sql.replace(/'(?:[^']|'')*'/g, "''");
  const out = new Map<string, string>();
  for (const m of withoutLiterals.matchAll(/([@:$])([A-Za-z_][A-Za-z0-9_]*)/g)) {
    out.set(m[2], `${m[1]}${m[2]}`);
  }
  return out;
}

/**
 * Is this single argument the NAMED-PARAMETER form, or one positional value?
 *
 * MEASURED (N0b-5a): bytes are a value, and they are also an object. Deciding
 * by `typeof` alone sent `run(new Uint8Array(…))` down the named path, where it
 * became "bound key '0' does not appear as a named parameter" — a message about
 * the wrong thing entirely. The contract now states this (`api` group: "binds a
 * lone bytes value as a positional parameter").
 */
function isNamedParams(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof ArrayBuffer)
  );
}

function toBindParams(params: unknown[], sigils: Map<string, string>): SQLiteBindParams {
  if (params.length === 1 && isNamedParams(params[0])) {
    const source = params[0];
    const translated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      // Already carrying a sigil: pass it through untouched.
      const named = /^[@:$]/.test(key) ? key : sigils.get(key);
      if (named === undefined) {
        throw new Error(`bound key '${key}' does not appear as a named parameter in the statement`);
      }
      translated[named] = value;
    }
    return translated as SQLiteBindParams;
  }
  return params as SQLiteBindParams;
}

/** The slice of expo's execute result this shim reads. */
interface ExecResult {
  readonly changes: number;
  readonly lastInsertRowId: number;
  getFirstSync(): unknown;
  getAllSync(): unknown[];
}

class ExpoStatement implements SqliteStatement {
  readonly #db: SQLiteDatabase;
  readonly #sql: string;
  readonly #sigils: Map<string, string>;
  readonly #options: ShimOptions;

  constructor(db: SQLiteDatabase, sql: string, options: ShimOptions) {
    this.#db = db;
    this.#sql = sql;
    this.#sigils = namedParamSigils(sql);
    this.#options = options;
  }

  /**
   * The one place a native statement exists. `consume` reads the cursor out
   * BEFORE the `finally` releases it.
   */
  #call<T>(params: unknown[], consume: (result: ExecResult) => T): T {
    const statement = this.#db.prepareSync(this.#sql);
    const counters = this.#options.counters;
    if (counters) counters.prepared++;

    let failed = false;
    try {
      const result = statement.executeSync(toBindParams(params, this.#sigils));
      return consume(result as unknown as ExecResult);
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      // MEASURED (N0b-2): after a failed execute, expo's `finalizeSync()`
      // THROWS — and what it throws is the statement's own last error, e.g.
      // "Call to function 'NativeStatement.finalizeSync' has been rejected. →
      // Caused by: Error code : UNIQUE constraint failed: songs.id". That is
      // `sqlite3_finalize()` behaving as documented: it returns the most recent
      // evaluation's error code, and it destroys the statement EITHER WAY.
      //
      // So a throw here is a second report of a failure already on its way up,
      // not a leak — the statement is gone, and `finalized` is incremented.
      // Letting it escape would replace "UNIQUE constraint failed" with a
      // message about finalizeSync, which is how a constraint error turns into
      // a mystery.
      //
      // Narrow on purpose: this is only tolerated when the execute ALREADY
      // failed. A finalize that throws after a SUCCESSFUL execute is something
      // nobody has explained, and it propagates.
      //
      // The leaky variant skips this whole block on the error path. Note it is
      // an `if`, not an early `return` — a `return` inside `finally` swallows
      // the exception on its way out, and then the reverse test would be
      // measuring "it stopped throwing" instead of "it stopped releasing".
      if (!(failed && this.#options.leakOnError === true)) {
        if (failed) {
          try {
            statement.finalizeSync();
          } catch {
            // Already reported by the error being propagated.
          }
        } else {
          statement.finalizeSync();
        }
        if (counters) counters.finalized++;
      }
    }
  }

  get(...params: unknown[]): unknown {
    // better-sqlite3 answers `undefined` on a miss; expo answers `null`.
    return this.#call(params, (r) => r.getFirstSync() ?? undefined);
  }

  all(...params: unknown[]): unknown[] {
    return this.#call(params, (r) => r.getAllSync());
  }

  run(...params: unknown[]): SqliteRunResult {
    return this.#call(params, (r) => ({
      changes: r.changes,
      lastInsertRowid: r.lastInsertRowId,
    }));
  }
}

export class ExpoSqliteShim implements SqliteLike {
  readonly db: SQLiteDatabase;
  readonly #options: ShimOptions;

  constructor(db: SQLiteDatabase, options: ShimOptions = {}) {
    this.db = db;
    this.#options = options;
  }

  prepare(sql: string): SqliteStatement {
    return new ExpoStatement(this.db, sql, this.#options);
  }

  exec(sql: string): unknown {
    this.db.execSync(sql);
    return undefined;
  }

  /**
   * better-sqlite3's two shapes over expo's one.
   *
   * The argument arrives WITHOUT the `PRAGMA` keyword (`'user_version'`,
   * `'table_info(songs)'`, `'journal_mode = WAL'`), which is better-sqlite3's
   * convention and therefore core's.
   */
  pragma(sql: string, options?: { simple?: boolean }): unknown {
    const rows = this.db.getAllSync(`PRAGMA ${sql}`) as Record<string, unknown>[];
    if (options?.simple !== true) return rows;
    const first = rows[0];
    if (first === undefined) return undefined;
    const values = Object.values(first);
    return values.length > 0 ? values[0] : undefined;
  }

  /**
   * Explicit BEGIN/COMMIT/ROLLBACK rather than expo's `withTransactionSync`,
   * for one reason: core needs `.immediate()`, and the wrapper only offers a
   * deferred BEGIN.
   *
   * Not reentrant, and deliberately so — nesting is outside the contract's
   * guarantee face (decision c2), and a shim that quietly emulated savepoints
   * would be promising something no case checks.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R) {
    const wrap =
      (begin: string) =>
      (...args: A): R => {
        this.db.execSync(begin);
        let result: R;
        try {
          result = fn(...args);
        } catch (err) {
          try {
            this.db.execSync('ROLLBACK');
          } catch {
            // Best effort — the original error is the informative one.
          }
          throw err;
        }
        this.db.execSync('COMMIT');
        return result;
      };

    const deferred = wrap('BEGIN');
    return Object.assign(deferred, { immediate: wrap('BEGIN IMMEDIATE') });
  }

  close(): unknown {
    this.db.closeSync();
    return undefined;
  }
}
