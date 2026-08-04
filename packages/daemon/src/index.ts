// @lark/daemon — the Fastify HTTP server that owns every write path. Runs
// headless (CLI) or spawned by the GUI; must never import Electron or @lark/gui
// (enforced by the daemon-no-gui-electron guard).

export { corsOriginDelegate, isHostAllowed, isOriginAllowed } from './access-guard.js';
export { bearerToken, isPublicPath, timingSafeEqualStr } from './auth.js';
export { type BootOptions, boot } from './boot.js';
export {
  type AppContext,
  CONTEXT_DEFAULTS,
  DAEMON_HOST,
  DAEMON_VERSION,
  DEFAULT_ACK_TIMEOUT_MS,
  type Logger,
} from './context.js';
export { EventsBus } from './events/bus.js';
export { GuiCapacityError, GuiChannel, type GuiConnection } from './events/gui-channel.js';
export { generateLocalToken, publishLocalToken } from './local-token.js';
export {
  DaemonAlreadyRunningError,
  PidFileCorruptError,
  acquireDaemonLock,
  readPid,
  removePid,
} from './pid.js';
export { type CommandOutcome, PlayerRuntime } from './player-runtime.js';
export { fail, ok } from './response.js';
export { buildServer, registerAllRoutes } from './server.js';
