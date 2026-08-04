// @lark/core — business logic and local state. Node-only, but must stay free of
// Electron and @lark/daemon so the daemon can run headless and the CLI can link
// core directly (enforced by the core-no-daemon-electron guard).

export * as paths from './paths.js';
export * from './config/index.js';
export * from './logger/index.js';
export * from './errors.js';
export * from './db/index.js';
export { LATEST_KNOWN_VERSION } from './db/migrate.js';
export * from './db/backup.js';
export * from './db/migrate-go.js';
export * from './db/probe-go.js';
export * from './db/lww.js';
export * from './library/source.js';
export * from './library/rank.js';
export * from './library/songs.js';
export * from './library/playlists.js';
export * from './library/lyrics.js';
