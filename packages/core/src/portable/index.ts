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

export * from './contract/index.js';
export * from './coordinator/client.js';
export * from './coordinator/context.js';
export * from './coordinator/login.js';
export * from './coordinator/logout.js';
export * from './coordinator/refresh.js';
export * from './coordinator/rounds.js';
export * from './coordinator/runner.js';
export * from './coordinator/runtime.js';
export * from './coordinator/session.js';
export * from './coordinator/status.js';
export * from './db-identity.js';
export * from './db.js';
export * from './download/batches.js';
export * from './download/bilibili.js';
export * from './download/claims.js';
export * from './download/engine.js';
export * from './download/link.js';
export * from './download/llm.js';
export * from './download/lyrics/kugou.js';
export * from './download/lyrics/lrc.js';
export * from './download/lyrics/netease.js';
export * from './download/lyrics/qq.js';
export * from './download/lyrics/select.js';
export * from './download/lyrics/shared.js';
export * from './download/pipeline.js';
export * from './download/prompts.js';
export * from './download/target.js';
export * from './download/task-data.js';
export * from './download/timeouts.js';
export * from './download/wbi.js';
export * from './errors.js';
export * from './library/cache.js';
export * from './library/lyrics.js';
export * from './library/playlists.js';
export * from './library/rank.js';
export * from './library/songs.js';
export * from './library/source.js';
export * from './library/transfer.js';
export * from './logger.js';
export * from './migrate.js';
export * from './open-library.js';
export * from './migrations/index.js';
export * from './now-playing-mode.js';
export * from './pending.js';
export * from './ports/index.js';
export * from './runtime/index.js';
export * from './services/contract/index.js';
export * from './services/library.js';
export * as schema from './schema.js';
export * from './schema-signature.js';
export * from './sqlite.js';
export * from './sync/apply.js';
export * from './sync/backfill.js';
export * from './sync/binding.js';
export * from './sync/changes.js';
export * from './sync/conflicts.js';
export * from './sync/device.js';
export * from './sync/duplicates.js';
export * from './sync/engine.js';
export * from './sync/file-ops.js';
export * from './sync/file-ops-runtime.js';
export * from './sync/hlc.js';
export * from './sync/lww.js';
export * from './sync/rebase.js';
export * from './sync/retention.js';
export * from './sync/retry.js';
export * from './sync/server-url.js';
export * from './sync/tombstones.js';
export * from './sync/unbind.js';
