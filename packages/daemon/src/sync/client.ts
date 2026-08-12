// The skybridge SDK, as the daemon uses it (v0.2 T3b, §4.1).
//
// Two jobs, both small on purpose:
//
//   ① Name the SDK surface behind an interface. lark depends on the client
//      package STATICALLY (unlike owl, which loads it dynamically because a
//      clean checkout may not have it) — the indirection here is not about
//      absence, it is about tests: a login sequence with seven failure points
//      has to be driven through a fake, and mocking a module is a worse tool
//      than passing one in.
//
//   ② Turn SDK errors into lark's error vocabulary. `ApiError` and
//      `NetworkError` mean nothing to a route or to the CLI's exit map, and
//      the distinction that matters — "your credentials are the problem" vs
//      "the server is the problem" — is one HTTP status away from being lost.
//
// Anything that is neither an ApiError nor a NetworkError passes through
// untouched. A TypeError from our own code must not be reported as an
// unreachable server.

import { SyncAuthRequiredError, SyncUnavailableError } from '@lark/core';
import {
  ApiError,
  type AuthContext,
  CLIENT_VERSION,
  NetworkError,
  type SkybridgeClient,
  createSkybridgeClient,
  getServerTime,
  login,
  refresh,
} from '@orpheus-aviary/skybridge-client';
import type { ApiRefreshResult } from '@orpheus-aviary/skybridge-proto';

export type { AuthContext, SkybridgeClient };

/** Everything the daemon calls on the SDK. Tests substitute this wholesale. */
export interface SkybridgeApi {
  login(serverUrl: string, email: string, password: string): Promise<AuthContext>;
  refresh(serverUrl: string, refreshToken: string): Promise<ApiRefreshResult>;
  /** Authoritative server clock, unauthenticated — the rebase anchor (§3.3). */
  serverTime(serverUrl: string): Promise<number>;
  createClient(options: { authContext: AuthContext; deviceId?: string }): SkybridgeClient;
}

export const realSkybridgeApi: SkybridgeApi = {
  login: (serverUrl, email, password) => login(serverUrl, email, password),
  refresh: (serverUrl, refreshToken) => refresh(serverUrl, refreshToken),
  serverTime: (serverUrl) => getServerTime(serverUrl),
  createClient: (options) => createSkybridgeClient(options),
};

/** The client version string this build reports when registering a device. */
export const SKYBRIDGE_CLIENT_VERSION = CLIENT_VERSION;

/**
 * Did the server tell us the credentials are the problem?
 *
 * 401 and 403 only. Everything else — including a 500 from an auth endpoint —
 * is the server having a bad day, and dropping a working session over it is
 * how a network blip turns into "please log in again".
 */
export function isAuthFailure(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

/** The protocol error code, when the failure carried one. */
export function skybridgeErrorCode(err: unknown): string | null {
  return err instanceof ApiError ? String(err.code) : null;
}

/**
 * Verdicts that mean the stored refresh token is dead: unknown, expired,
 * revoked, or presented after it was rotated (which nukes the whole family).
 */
const DEAD_REFRESH_CODES: ReadonlySet<string> = new Set(['REFRESH_INVALID', 'REFRESH_REPLAYED']);

/**
 * Is this refresh failure permanent?
 *
 * Fails SAFE toward "no": only an explicit server verdict counts. Treating a
 * network blip as a dead token would log the user out for a lost packet, and
 * the cost of being wrong the other way is one more failed refresh in a
 * minute's time.
 */
export function isRefreshTokenDead(err: unknown): boolean {
  return (
    isAuthFailure(err) || (err instanceof ApiError && DEAD_REFRESH_CODES.has(String(err.code)))
  );
}

/**
 * Translate an SDK failure into lark's vocabulary.
 *
 * `what` names the call, because the message reaches a human: "login failed"
 * and "pull failed" lead to different next moves even when the status is the
 * same.
 */
export function translateSkybridgeError(err: unknown, what: string): unknown {
  if (isAuthFailure(err)) {
    return new SyncAuthRequiredError(`${what} was refused: ${(err as ApiError).message}`);
  }
  if (err instanceof ApiError) {
    return new SyncUnavailableError(`${what} failed: ${err.message}`, err.status, { cause: err });
  }
  if (err instanceof NetworkError) {
    return new SyncUnavailableError(`${what} could not reach the server: ${err.message}`, null, {
      cause: err,
    });
  }
  return err;
}

/** Run an SDK call, translating whatever it throws. */
export async function callSkybridge<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw translateSkybridgeError(err, what);
  }
}
