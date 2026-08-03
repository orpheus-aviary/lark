import { DEFAULT_DAEMON_PORT } from '@lark/shared';

/** Daemon package version — reported by `GET /status` and `--version`. */
export const DAEMON_VERSION = '0.1.0';

/** Loopback only. The daemon is a local service; nothing binds a public NIC. */
export const DAEMON_HOST = '127.0.0.1';

/**
 * Structured logger, shaped like pino's `(fields, msg)` call signature — the
 * daemon subcommand injects the real `@lark/core` pino/pino-roll file logger
 * (cli.ts, M1-15); pino's Logger satisfies this structurally.
 */
export interface Logger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

/** Shared application context passed to every route handler. */
export interface AppContext {
  config: {
    port: number;
    host: string;
  };
  logger: Logger;
}

/** Console-backed logger — dev default and test-injection stand-in (no file IO). */
export function createConsoleLogger(): Logger {
  const emit = (level: string, fields: Record<string, unknown>, msg: string): void => {
    const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
    if (level === 'error') console.error(line);
    else console.log(line);
  };
  return {
    info: (fields, msg) => emit('info', fields, msg),
    warn: (fields, msg) => emit('warn', fields, msg),
    error: (fields, msg) => emit('error', fields, msg),
  };
}

/** Default context for a locally booted daemon. */
export function createContext(overrides: Partial<AppContext> = {}): AppContext {
  return {
    config: { port: DEFAULT_DAEMON_PORT, host: DAEMON_HOST },
    logger: createConsoleLogger(),
    ...overrides,
  };
}
