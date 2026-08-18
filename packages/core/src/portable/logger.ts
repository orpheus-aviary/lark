// The logger core components ask for (N1a).
//
// A TYPE and nothing else: portable code writes log lines, it does not decide
// where they go. The desktop hands it pino (`logger/index.ts`), the daemon's
// context hands it four methods, tests hand it a recorder, and the mobile
// client will hand it whatever it has — none of that is core's business.
//
// It lives here rather than beside `createLogger` because that factory is
// pino + `node:fs`, and a component that only ever calls `warn` must not drag a
// file-rolling transport into the module graph to say so.

export interface StructuredLogger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}
