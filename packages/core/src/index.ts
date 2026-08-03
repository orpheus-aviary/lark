// @lark/core — business logic and local state. Node-only, but must stay free of
// Electron and @lark/daemon so the daemon can run headless and the CLI can link
// core directly (enforced by the core-no-daemon-electron guard).

export * as paths from './paths.js';
export * from './config/index.js';
export * from './logger/index.js';
