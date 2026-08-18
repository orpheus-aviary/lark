// Structured error types (T3). daemon / CLI / GUI render UX by instanceof +
// fields — never by parsing message strings. All exported from the core barrel.
//
// The classes themselves live in `portable/errors.ts` (N1a): portable code
// throws them, and portable may not import core. This file stays the address
// every consumer already knows — a re-export is not a redefinition, so
// `instanceof` in the daemon and `err.name` in the CLI's dynamic-import backend
// keep seeing the same class objects they always did.

export * from './portable/errors.js';
