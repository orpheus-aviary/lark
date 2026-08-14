// pino logger factories (M1-15): file-rolling for the daemon/GUI, stdout for
// dev/CLI. Both install the same redact paths, so any structured log line
// carrying a token or api_key field is masked before serialization. Raw
// string interpolation sidesteps `pino.redact` entirely — that's the job of
// the grep guard landing in M2 alongside the token guard.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogConfig } from '@lark/shared';
import pino from 'pino';

export type Logger = pino.Logger;

/**
 * The four calls core actually makes on a logger, as a structural type.
 *
 * pino's `Logger` satisfies it, so nothing changes for the daemon's own file
 * logger — but a caller that holds a narrower logger (the daemon's context
 * carries exactly these four methods, and tests carry a recorder) can pass it
 * without a cast. Asking for pino's full surface where only `warn` is called
 * would push a lie into the one place that must not have one: a component that
 * takes a logger it will never use as pino.
 */
export interface StructuredLogger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

export interface LoggerOptions {
  /** Log file path (nest layout: `lark/logs/lark.log`, single file). */
  filePath: string;
  /** `[log]` section from lark_config.toml. */
  config: LogConfig;
  /** Logger name (e.g. 'daemon', 'gui'). */
  name: string;
}

/**
 * Default `pino.redact` paths. pino's `*` matches exactly ONE level, so the
 * top-level shapes (`{ token }`, `{ api_key }`) and the deep llm shape
 * (`{ config: { llm: { api_key } } }`) each need their own entry — `*.api_key`
 * covers neither. Anything nested deeper than one owner level is out of
 * contract: config objects must never be logged whole — log
 * `redactConfig(cfg)` instead (M1-15).
 */
export const DEFAULT_LOG_REDACT_PATHS: readonly string[] = [
  // token family
  'token',
  '*.token',
  '*.auth.token',
  // authorization headers
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  // llm api_key family
  'api_key',
  '*.api_key',
  'llm.api_key',
  '*.llm.api_key',
];

const DEFAULT_REDACT = {
  paths: [...DEFAULT_LOG_REDACT_PATHS],
  censor: '[REDACTED]',
};

/** Create a pino logger with size + daily rotation via pino-roll. */
export function createLogger(options: LoggerOptions): Logger {
  const { filePath, config, name } = options;

  mkdirSync(dirname(filePath), { recursive: true });

  const transport = pino.transport({
    target: 'pino-roll',
    options: {
      file: filePath,
      size: `${config.max_size_mb}m`,
      frequency: 'daily',
      limit: { count: config.max_backups },
      mkdir: true,
    },
  });

  return pino(
    {
      name,
      level: config.level,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: DEFAULT_REDACT,
    },
    transport,
  );
}
