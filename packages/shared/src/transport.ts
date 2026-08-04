// HTTP transport for the lark daemon REST API. Host-agnostic: the front-end
// injects how to resolve the daemon base URL and which auth headers to attach
// via `configureTransport`, so the same client code serves the Electron
// renderer, the CLI and (later) mobile.

import type { ApiResponse } from './types.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    public errorCode: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface TransportConfig {
  /** Resolve the daemon base URL. `''` = same-origin relative. */
  baseUrl: () => string;
  /**
   * Headers attached to every request. Empty until M2 wires the daemon's local
   * token; reading it through a callback (never a cached string) is what lets a
   * daemon restart rotate the token without a client restart (R29).
   */
  getAuthHeaders: () => Record<string, string>;
}

const config: TransportConfig = {
  baseUrl: () => '',
  getAuthHeaders: () => ({}),
};

/** Wire the transport to its host. Call once at front-end startup (and in tests). */
export function configureTransport(opts: {
  baseUrl: () => string;
  getAuthHeaders?: () => Record<string, string>;
}): void {
  config.baseUrl = opts.baseUrl;
  if (opts.getAuthHeaders) config.getAuthHeaders = opts.getAuthHeaders;
}

/** Resolve the daemon base URL — exported so SSE callers (M2) can reuse it. */
export function baseUrl(): string {
  return config.baseUrl();
}

/**
 * A fresh copy of the configured auth headers. Re-read (never cached) so a
 * daemon restart's token rotation is picked up on the next call (R29); the
 * copy is what lets an SSE attempt hold ONE snapshot for both the request
 * headers and the `usedToken` it reports on disconnect (M2-14).
 */
export function authHeaders(): Record<string, string> {
  return { ...config.getAuthHeaders() };
}

const RETRY_BACKOFF_MS = 500;

/**
 * Default retry count per method (M0-7). GET is the only method retried by
 * default: owl retries every method, which duplicates playlist creates /
 * imports / downloads when the server committed but the response was lost.
 * Everything else — including HEAD, whose bodyless response is incompatible
 * with the envelope parsing below — starts at 0. A write that wants retries
 * must pass `retries` explicitly AND have an idempotency key.
 */
function defaultRetries(method: string): number {
  return method.toUpperCase() === 'GET' ? 2 : 0;
}

function unwrap<T>(res: Response, json: ApiResponse<T>): ApiResponse<T> {
  if (json.success) return json;
  throw new ApiError(res.status, json.error_code, json.message ?? 'Unknown error');
}

/**
 * Issue an API request and return the envelope, or throw {@link ApiError}.
 *
 * Retries cover the fetch network layer ONLY (connection refused / reset /
 * timeout — the daemon restarting). Once a response is received, its outcome is
 * final: 401, 5xx and a non-JSON body all throw on the first attempt.
 */
export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  retries: number = defaultRetries(method),
): Promise<ApiResponse<T>> {
  const url = `${baseUrl()}${path}`;
  const headers: Record<string, string> = { ...config.getAuthHeaders() };
  const init: RequestInit = { method };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (Object.keys(headers).length > 0) init.headers = headers;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt >= retries) throw err;
      // The daemon may be restarting — back off, then retry.
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
      continue;
    }

    let json: ApiResponse<T>;
    try {
      json = (await res.json()) as ApiResponse<T>;
    } catch {
      throw new ApiError(
        res.status,
        'INVALID_RESPONSE',
        `daemon returned a non-JSON response (HTTP ${res.status})`,
      );
    }
    return unwrap(res, json);
  }
}
