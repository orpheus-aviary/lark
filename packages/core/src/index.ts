// @lark/core — business logic and local state. Node-only, but must stay free of
// Electron and @lark/daemon so the daemon can run headless and the CLI can link
// core directly (enforced by the core-no-daemon-electron guard).

import { installNodeRuntime } from './node-runtime.js';

// Before any export is touched: `portable/runtime` refuses to guess at a
// whole-file digest, and this barrel is the door every desktop consumer comes
// through (N1a).
installNodeRuntime();

export * as paths from './paths.js';
export {
  CANONICAL_AUDIO_FILE,
  LEGACY_AUDIO_FILE,
  songAudioPath,
  songDirPath,
  songLyricsPath,
} from './paths.js';
export * from './node-fs.js';
export type * from './portable/ports/index.js';
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
export * from './portable/coordinator/client.js';
export * from './portable/coordinator/context.js';
export * from './portable/coordinator/login.js';
export * from './portable/coordinator/logout.js';
export * from './portable/coordinator/refresh.js';
export * from './portable/coordinator/rounds.js';
export * from './portable/coordinator/runner.js';
export * from './portable/coordinator/runtime.js';
export * from './portable/coordinator/session.js';
export * from './portable/coordinator/status.js';
export * from './portable/coordinator/stream.js';
export * from './portable/services/contract/index.js';
export * from './portable/services/contract/audio-landing/index.js';
export * from './portable/services/library.js';
export * from './portable/sync/apply.js';
export * from './portable/sync/backfill.js';
export * from './portable/sync/binding.js';
export * from './portable/sync/changes.js';
export * from './portable/sync/conflicts.js';
export * from './portable/sync/device.js';
export * from './portable/sync/duplicates.js';
export * from './portable/sync/engine.js';
export * from './portable/sync/file-ops.js';
export * from './sync/file-ops-runtime.js';
export * from './portable/sync/hlc.js';
export * from './portable/sync/lww.js';
export * from './portable/sync/rebase.js';
export * from './portable/sync/retention.js';
export * from './portable/sync/retry.js';
export * from './portable/sync/server-url.js';
export * from './portable/sync/tombstones.js';
export * from './portable/sync/unbind.js';
export * from './portable/library/source.js';
export * from './portable/library/rank.js';
export * from './portable/library/songs.js';
export * from './portable/library/playlists.js';
export * from './portable/library/lyrics.js';
export * from './portable/library/cache.js';
export * from './portable/library/eviction-runtime.js';
export * from './portable/library/transfer.js';
export * from './media-tools/index.js';
export * from './portable/download/timeouts.js';
export * from './portable/download/llm.js';
export * from './portable/download/prompts.js';
export * from './portable/download/wbi.js';
export * from './portable/download/bilibili.js';
export * from './portable/download/link.js';
export * from './download/ffmpeg.js';
export * from './portable/download/lyrics/lrc.js';
export * from './portable/download/lyrics/shared.js';
export * from './portable/download/lyrics/netease.js';
export * from './portable/download/lyrics/qq.js';
export * from './portable/download/lyrics/kugou.js';
export * from './portable/download/lyrics/select.js';
export * from './portable/download/claims.js';
export * from './download/audio-landing.js';
export * from './download/resolve.js';
export * from './download/import.js';
export * from './portable/download/pipeline.js';
export * from './portable/download/preflight.js';
export * from './portable/download/source-url.js';
export * from './portable/download/target.js';
export * from './portable/download/task-data.js';
export * from './portable/download/batches.js';
export * from './portable/download/engine.js';
