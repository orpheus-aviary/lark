import {
  API_PATHS,
  type ApiResponse,
  type StatusData,
  configureTransport,
  defaultDaemonBaseUrl,
  request,
} from '@lark/shared';
import type { Backend } from './types.js';

/** Talk to a running daemon over HTTP — the default (and M0's only) backend. */
export function createHttpBackend(baseUrl: string = defaultDaemonBaseUrl()): Backend {
  configureTransport({ baseUrl: () => baseUrl });
  return {
    status: (): Promise<ApiResponse<StatusData>> => request<StatusData>('GET', API_PATHS.status),
  };
}
