// The one error type every command throws (M6-6).
//
// A command never decides how a failure is printed or what the process exits
// with: it throws a `CliError` carrying a registered code, and the top-level
// handler renders it — as an envelope under `--json`, as one line otherwise —
// and exits by the table. That is what makes "exit 0 ⇔ stdout holds exactly
// one success envelope" true by construction rather than by discipline.

import { ApiError } from '@lark/shared';
import { type CliErrorCode, isCliErrorCode } from './exit-codes.js';

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: CliErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.details = details;
  }
}

/** `USAGE_ERROR` is frequent enough to deserve a shorthand. */
export function usageError(message: string, details?: Record<string, unknown>): CliError {
  return new CliError('USAGE_ERROR', message, details);
}

/**
 * Translate anything thrown by the transport into a `CliError`.
 *
 * A daemon code that is not in the registry does not become "unknown error":
 * it degrades to `HTTP_ERROR` and the original travels on in
 * `details.daemon_code`, so a newer daemon talking to an older CLI still says
 * something a human (or an agent) can act on.
 */
export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;

  if (err instanceof ApiError) {
    if (isCliErrorCode(err.errorCode)) {
      return new CliError(err.errorCode, err.message, err.details);
    }
    return new CliError('HTTP_ERROR', err.message, {
      ...err.details,
      http_status: err.status,
      ...(err.errorCode === undefined ? {} : { daemon_code: err.errorCode }),
    });
  }

  // Everything else: a bug, a filesystem error, a network stack failure. The
  // message is kept verbatim — guessing a nicer one hides what happened.
  return new CliError('UNKNOWN', err instanceof Error ? err.message : String(err));
}
