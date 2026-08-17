// The op-sqlite side of the comparison (N0b-2, criterion 16).
//
// Same contract, second host. The verdict rule is fixed in advance so the
// comparison cannot be read after the fact: expo-sqlite all green means
// expo-sqlite, and only a case where expo is RED and op is GREEN reopens the
// choice.
//
// Two structural differences show up in op-sqlite's type surface before a line
// runs, and both are recorded rather than papered over:
//
//   1. `Scalar` has no object form — `executeSync(sql, params)` takes POSITIONAL
//      parameters only. core binds named objects (`migration/scanner.ts`), so
//      this adapter rewrites `@name` into `?` in order of appearance. That is
//      more shim logic than expo needs, and more places to be subtly wrong.
//   2. `PreparedStatement.execute()` is ASYNC only — there is no synchronous
//      execute on a prepared statement, and no finalize on the public API at
//      all. So the per-call one-shot below is the only synchronous model
//      available, and the counted lifecycle cases are NOT MEASURABLE here: the
//      adapter reports no counters and the contract skips them out loud.

import type {
  ContractDatabase,
  ContractHooks,
  SqliteLike,
  SqliteRunResult,
  SqliteStatement,
  SqliteTransaction,
} from '@lark/core/portable';
import { type DB, type Scalar, open } from '@op-engineering/op-sqlite';

/**
 * `@name` / `:name` / `$name` → `?`, plus the order the names appear in.
 *
 * Quoted literals are stripped first, exactly as in the expo shim: a JSON path
 * like `'$.updated_at_ms'` is not a parameter.
 */
function toPositional(sql: string): { sql: string; names: string[] } {
  const names: string[] = [];
  let out = '';
  let index = 0;
  let inLiteral = false;

  while (index < sql.length) {
    const ch = sql[index];
    if (inLiteral) {
      out += ch;
      if (ch === "'") inLiteral = false;
      index += 1;
      continue;
    }
    if (ch === "'") {
      inLiteral = true;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === '@' || ch === ':' || ch === '$') {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index + 1));
      if (match) {
        names.push(match[0]);
        out += '?';
        index += 1 + match[0].length;
        continue;
      }
    }
    out += ch;
    index += 1;
  }

  return { sql: out, names };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Split a multi-statement script on the semicolons that actually separate
 * statements — i.e. not the ones inside `'literals'`, `-- line comments` or
 * block comments.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let index = 0;

  while (index < sql.length) {
    const ch = sql[index];
    const next = sql[index + 1];

    if (ch === "'") {
      const end = sql.indexOf("'", index + 1);
      const stop = end === -1 ? sql.length : end + 1;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) out.push(trimmed);
      current = '';
      index += 1;
      continue;
    }
    current += ch;
    index += 1;
  }

  const tail = current.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

class OpStatement implements SqliteStatement {
  readonly #db: DB;
  readonly #sql: string;
  readonly #names: string[];

  constructor(db: DB, sql: string) {
    this.#db = db;
    const rewritten = toPositional(sql);
    this.#sql = rewritten.sql;
    this.#names = rewritten.names;
  }

  #params(params: unknown[]): Scalar[] {
    if (params.length === 1 && isPlainObject(params[0])) {
      const source = params[0];
      return this.#names.map((name) => {
        if (!(name in source)) {
          throw new Error(`no bound value for named parameter '${name}'`);
        }
        return source[name] as Scalar;
      });
    }
    return params as Scalar[];
  }

  get(...params: unknown[]): unknown {
    const result = this.#db.executeSync(this.#sql, this.#params(params));
    return result.rows.length > 0 ? result.rows[0] : undefined;
  }

  all(...params: unknown[]): unknown[] {
    return this.#db.executeSync(this.#sql, this.#params(params)).rows;
  }

  run(...params: unknown[]): SqliteRunResult {
    const result = this.#db.executeSync(this.#sql, this.#params(params));
    return { changes: result.rowsAffected, lastInsertRowid: result.insertId ?? 0 };
  }
}

class OpSqliteAdapter implements SqliteLike {
  readonly #db: DB;

  constructor(db: DB) {
    this.#db = db;
  }

  prepare(sql: string): SqliteStatement {
    return new OpStatement(this.#db, sql);
  }

  exec(sql: string): unknown {
    // op-sqlite's sync API has no multi-statement exec (expo's `execSync` does),
    // so the shim has to split — which means it has to KNOW SQL.
    //
    // The first version split on `;` and every migration case went red at 0002,
    // on a line comment that happens to contain a semicolon: "…to match the
    // entity tables; comparison reads NULL as ''." That is the cost this host
    // carries, demonstrated within a minute: work expo does not need, in a
    // place that is easy to get subtly wrong.
    for (const statement of splitStatements(sql)) {
      this.#db.executeSync(statement);
    }
    return undefined;
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    const rows = this.#db.executeSync(`PRAGMA ${sql}`).rows;
    if (options?.simple !== true) return rows;
    const first = rows[0];
    if (first === undefined) return undefined;
    const values = Object.values(first);
    return values.length > 0 ? values[0] : undefined;
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): SqliteTransaction<A, R> {
    // op-sqlite's own `transaction()` is async; core needs a synchronous
    // `.immediate()`, so this drives BEGIN/COMMIT/ROLLBACK directly.
    const wrap =
      (begin: string) =>
      (...args: A): R => {
        this.#db.executeSync(begin);
        let result: R;
        try {
          result = fn(...args);
        } catch (err) {
          try {
            this.#db.executeSync('ROLLBACK');
          } catch {
            // Best effort — the original error is the informative one.
          }
          throw err;
        }
        this.#db.executeSync('COMMIT');
        return result;
      };
    const deferred = wrap('BEGIN');
    return Object.assign(deferred, { immediate: wrap('BEGIN IMMEDIATE') });
  }

  close(): unknown {
    this.#db.close();
    return undefined;
  }
}

let sequence = 0;

export function opSqliteHooks(): ContractHooks {
  return {
    open(): ContractDatabase {
      sequence += 1;
      const name = `op-contract-${sequence}.db`;
      let db = open({ name });
      try {
        db.delete();
      } catch {
        // Nothing to delete.
      }
      db = open({ name });
      let adapter = new OpSqliteAdapter(db);

      return {
        get sqlite() {
          return adapter;
        },
        reopen(): SqliteLike {
          db.close();
          db = open({ name });
          adapter = new OpSqliteAdapter(db);
          return adapter;
        },
        cleanup() {
          try {
            db.close();
          } catch {
            // Already closed.
          }
          try {
            open({ name }).delete();
          } catch {
            // Nothing to delete.
          }
        },
        // No counters: op-sqlite's public sync API exposes neither prepare nor
        // finalize, so the lifecycle group is reported as skipped rather than
        // guessed at.
      };
    },
    // No drizzle binding: drizzle ships no op-sqlite driver, which is itself
    // part of the comparison.
  };
}
