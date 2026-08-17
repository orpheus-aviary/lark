// ContractHooks for expo-sqlite (N0b-2, criterion 14).
//
// File databases, one per case, deleted afterwards. `:memory:` is not an option
// the contract allows — `reopen()` on an in-memory database hands back a
// different, empty one, and every lock and persistence case would pass without
// testing anything.
//
// The counters live on the ContractDatabase, not on the shim, so they survive
// `reopen()`: a case that measures 10k calls and then reopens must not have its
// evidence reset by the reopen.

import {
  type ContractDatabase,
  type ContractHooks,
  type ContractSongRow,
  type DrizzleContractDatabase,
  type SqliteLike,
  schema,
} from '@lark/core/portable';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { type SQLiteDatabase, deleteDatabaseSync, openDatabaseSync } from 'expo-sqlite';
import { ExpoSqliteShim, type ShimCounters } from './shim';

let sequence = 0;

function freshName(): string {
  sequence += 1;
  return `contract-${sequence}.db`;
}

interface OpenedDatabase {
  contract: ContractDatabase;
  raw(): SQLiteDatabase;
}

function openFileDatabase(leakOnError: boolean): OpenedDatabase {
  const name = freshName();
  // A stale file from an interrupted run would hand the next case a database
  // that is not empty, which is the one thing every case assumes.
  try {
    deleteDatabaseSync(name);
  } catch {
    // Nothing to delete — the normal case.
  }

  const counters: ShimCounters = { prepared: 0, finalized: 0 };
  let db = openDatabaseSync(name);
  let shim = new ExpoSqliteShim(db, { counters, leakOnError });

  const contract: ContractDatabase = {
    get sqlite() {
      return shim;
    },
    reopen(): SqliteLike {
      db.closeSync();
      db = openDatabaseSync(name);
      shim = new ExpoSqliteShim(db, { counters, leakOnError });
      return shim;
    },
    cleanup() {
      try {
        db.closeSync();
      } catch {
        // Already closed by a case that reopened.
      }
      try {
        deleteDatabaseSync(name);
      } catch {
        // Nothing to delete.
      }
    },
    counters: {
      prepared: () => counters.prepared,
      finalized: () => counters.finalized,
    },
  };

  return { contract, raw: () => db };
}

/**
 * `leakOnError` is the on-device half of criterion 6: the same suite, run
 * against a shim carrying the bug, has to go red — otherwise the green run is
 * a claim nobody has tested (criterion 14).
 */
export function expoSqliteHooks(options: { leakOnError?: boolean } = {}): ContractHooks {
  const leakOnError = options.leakOnError === true;
  return {
    open: () => openFileDatabase(leakOnError).contract,
    drizzle: (): DrizzleContractDatabase => {
      const { contract, raw } = openFileDatabase(leakOnError);
      // Same handle the shim wraps — which is the whole point of the shared
      // connection group. A second `openDatabaseSync` here would pass every
      // "is it committed yet" check and fail the uncommitted-window ones.
      const orm = () => drizzle(raw(), { schema });
      return {
        ...contract,
        get sqlite() {
          return contract.sqlite;
        },
        get counters() {
          return contract.counters;
        },
        insertSongViaDrizzle(row: ContractSongRow) {
          orm().insert(schema.songs).values(row).run();
        },
        inDrizzleTransaction(assertWithRaw: (sqlite: SqliteLike) => void) {
          orm().transaction(() => {
            assertWithRaw(contract.sqlite);
          });
        },
      };
    },
  };
}
