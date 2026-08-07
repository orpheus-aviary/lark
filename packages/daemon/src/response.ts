import type { ApiResponse, DaemonEnvelopeErrorCode } from '@lark/shared';
import type { FastifyReply } from 'fastify';

/**
 * The uniform `{ success, data, message }` envelope. Documented exceptions
 * (master plan R15): `/audio` (binary + Range), `/lyrics` (text/plain),
 * `/events` (SSE) — those routes send raw payloads and land in M2/M3.
 */
export function ok<T>(reply: FastifyReply, data: T, message?: string, total?: number): void {
  const body: ApiResponse<T> = { success: true, data, message };
  if (total !== undefined) body.total = total;
  reply.send(body);
}

/**
 * The failure envelope. `errorCode` is typed against the shared registry
 * (M6-6): every code this daemon can emit is therefore a code the CLI has an
 * exit code for, checked at compile time on both ends. Codes from outside —
 * Fastify's `FST_ERR_*`, say — must be narrowed by the caller before they get
 * here, not passed through to a client that has no mapping for them.
 */
export function fail(
  reply: FastifyReply,
  status: number,
  message: string,
  errorCode?: DaemonEnvelopeErrorCode,
  details?: Record<string, unknown>,
): void {
  const body: ApiResponse = { success: false, message, error_code: errorCode };
  if (details !== undefined) body.details = details;
  reply.status(status).send(body);
}
