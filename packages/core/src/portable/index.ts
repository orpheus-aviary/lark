// `@lark/core/portable` — the part of core that runs anywhere there is a
// SQLite handle (N0a).
//
// Nothing here imports a Node builtin, better-sqlite3, or the rest of core;
// `scripts/check-core-portable.sh` enforces that, including deep relative
// escapes and self-imports through the package name. What that buys is a
// mobile client that runs the SAME schema, the SAME migration chain and the
// SAME "is this the current schema" verdict as the desktop — not a second
// implementation that agrees for a while.
//
// The desktop keeps consuming these modules by relative path (`db/index.ts`
// and friends); this barrel is the entry point OUTSIDE the package.

export * from './errors.js';
export * from './migrate.js';
export * from './migrations/index.js';
export * from './pending.js';
export * as schema from './schema.js';
export * from './schema-signature.js';
export * from './sqlite.js';
