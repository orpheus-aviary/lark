// @lark/core — business logic and local state. Node-only, but must stay free of
// Electron and @lark/daemon so the daemon can run headless and the CLI can link
// core directly (enforced by the core-no-daemon-electron guard).

import { installNodeRuntime } from './node-runtime.js';

// Before any export is touched: `portable/runtime` refuses to guess at a
// whole-file digest, and this barrel is the door every desktop consumer comes
// through (N1a).
installNodeRuntime();

export * as paths from './paths.js';
export * from './config/index.js';
export * from './daemon-control/index.js';
export * from './logger/index.js';
export * from './errors.js';
export * from './native-probe.js';
export * from './db/index.js';
export * from './db/readonly.js';
export * from './db/writer-lock.js';
export { LATEST_KNOWN_VERSION } from './portable/migrate.js';
export type { PortableDb, PortableDrizzle, PortableRunResult } from './portable/db.js';
export * from './db/backup.js';
export * from './backup-nest.js';
// The one-time mp3 → m4a migration (0.3.0). The daemon owns the runner; core
// owns the ledger's vocabulary, the failure classification and the verdict on
// a conversion result.
export * from './migration/backup.js';
export * from './migration/converter.js';
export * from './migration/error-class.js';
export * from './migration/ledger.js';
export * from './portable/pending.js';
export * from './migration/preflight.js';
export * from './migration/scanner.js';
export * from './migration/verify.js';
// sync (v0.2). The engine and apply land in T2; these are what the write
// paths and the daemon already need.
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
export * from './library/source.js';
export * from './library/rank.js';
export * from './library/songs.js';
export * from './library/playlists.js';
export * from './library/lyrics.js';
export * from './library/cache.js';
export * from './library/transfer.js';
export * from './media-tools/index.js';
export * from './download/timeouts.js';
export * from './download/llm.js';
export * from './download/prompts.js';
export * from './download/wbi.js';
export * from './download/bilibili.js';
export * from './download/link.js';
export * from './download/ffmpeg.js';
export * from './download/lyrics/lrc.js';
export * from './download/lyrics/shared.js';
export * from './download/lyrics/netease.js';
export * from './download/lyrics/qq.js';
export * from './download/lyrics/kugou.js';
export * from './download/lyrics/select.js';
export * from './download/claims.js';
export * from './download/resolve.js';
export * from './download/import.js';
export * from './download/pipeline.js';
export * from './download/target.js';
export * from './download/task-data.js';
export * from './download/batches.js';
export * from './download/engine.js';
