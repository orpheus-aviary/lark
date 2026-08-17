// Every contract case, in the order they are reported.
//
// The drizzle group is typed against the richer database, which is safe because
// `requires: 'drizzle'` is what the runner dispatches on — the type is
// documentation for whoever writes the next case, the field is the guard.

import type { ContractCase, ContractDatabase } from '../types.js';
import { API_CASES } from './api.js';
import { LIFECYCLE_CASES } from './lifecycle.js';
import { MIGRATION_CASES } from './migrations.js';
import { SHARED_CONNECTION_CASES } from './shared-connection.js';
import { SQL_CASES } from './sql.js';
import { TRANSACTION_CASES } from './transactions.js';

export const CONTRACT_CASES: readonly ContractCase<ContractDatabase>[] = [
  ...API_CASES,
  ...TRANSACTION_CASES,
  ...SQL_CASES,
  ...MIGRATION_CASES,
  ...LIFECYCLE_CASES,
  ...SHARED_CONNECTION_CASES,
];
