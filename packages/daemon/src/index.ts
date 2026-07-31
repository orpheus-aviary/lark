// @lark/daemon — the Fastify HTTP server that owns every write path. Runs
// headless (CLI) or spawned by the GUI; must never import Electron or @lark/gui
// (enforced by the daemon-no-gui-electron guard).

export { isOriginAllowed, corsOriginDelegate } from './access-guard.js';
export {
  DAEMON_HOST,
  DAEMON_VERSION,
  createConsoleLogger,
  createContext,
  type AppContext,
  type Logger,
} from './context.js';
export { fail, ok } from './response.js';
export { buildServer } from './server.js';
