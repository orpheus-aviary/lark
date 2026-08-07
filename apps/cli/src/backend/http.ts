import {
  API_PATHS,
  type StatusData,
  configureTransport,
  defaultDaemonBaseUrl,
  request,
} from '@lark/shared';
import { daemonAuthHeaders } from '../lib/auth.js';
import { CliError } from '../lib/errors.js';
import type { Backend } from './types.js';

/**
 * Talk to a running daemon over HTTP — the default backend.
 *
 * Auth is wired ONCE, here, as a callback: the transport asks for headers per
 * request, so `daemonAuthHeaders()` re-reads the token file every time and a
 * daemon that rotated its token mid-command is followed rather than fought
 * (R29).
 */
export function createHttpBackend(baseUrl: string = defaultDaemonBaseUrl()): Backend {
  configureTransport({ baseUrl: () => baseUrl, getAuthHeaders: () => daemonAuthHeaders() });
  return {
    status: () => call(() => request<StatusData>('GET', API_PATHS.status)),
  };
}

/**
 * Turn a connection-level failure into the state it actually describes.
 *
 * The transport throws the raw fetch error when nothing is listening; that is
 * `DAEMON_UNAVAILABLE` (exit 4, "start one"), not a generic failure. Response
 * errors already arrive as `ApiError` and are translated by `toCliError`.
 */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TypeError) {
      throw new CliError(
        'DAEMON_UNAVAILABLE',
        `连接不上 daemon（${defaultDaemonBaseUrl()}）：${err.message}`,
      );
    }
    throw err;
  }
}
