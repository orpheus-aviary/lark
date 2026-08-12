// What a failed sync round means, and when to try again (v0.2 T2).
//
// The daemon has to answer three questions after every round: does the user
// need to do something, will trying again help, and how long should it wait.
// Getting the first two wrong is worse than either failure: retrying a
// rejected password forever locks the account, and giving up on a laptop that
// closed its lid leaves the library silently out of date.
//
// The classification reads the shape of the error, never its message — a
// message is a locale away from meaningless.

/** What happened, in the only three flavours the caller acts on differently. */
export type SyncFailureKind =
  /** Credentials are gone or refused. Stop; only the user can fix this. */
  | 'auth'
  /** The server said no in a way retrying cannot change (4xx, bad request). */
  | 'permanent'
  /** Network, timeout, 5xx, offline. Try again later. */
  | 'transient';

export interface SyncFailure {
  kind: SyncFailureKind;
  status?: number;
  message: string;
}

interface ErrorShape {
  status?: unknown;
  statusCode?: unknown;
  name?: unknown;
  message?: unknown;
  code?: unknown;
}

function readStatus(err: ErrorShape): number | undefined {
  for (const value of [err.status, err.statusCode]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Classify a thrown sync error.
 *
 * Anything without a status is treated as transient: an exception with no HTTP
 * shape came from the transport, and the transport failing is the definition
 * of "try again". The cost of being wrong here is a retry, while the cost of
 * calling a network blip permanent is a device that stops syncing until
 * somebody notices.
 */
export function classifySyncFailure(err: unknown): SyncFailure {
  const shape = (typeof err === 'object' && err !== null ? err : {}) as ErrorShape;
  const message = err instanceof Error ? err.message : String(err);
  const status = readStatus(shape);

  if (status === 401 || status === 403) return { kind: 'auth', status, message };
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { kind: 'permanent', status, message };
  }
  return { kind: 'transient', ...(status === undefined ? {} : { status }), message };
}

/** Backoff for consecutive transient failures, in ms. Capped, then flat. */
const BACKOFF_MS = [10_000, 30_000, 60_000, 300_000, 900_000];

export function nextSyncBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return BACKOFF_MS[Math.min(consecutiveFailures, BACKOFF_MS.length) - 1];
}
