import { contextBridge } from 'electron';
import type { LarkApi } from '../shared/lark-api.js';

const DAEMON_URL_FLAG = '--daemon-url=';

/** Read the daemon base URL main injected via `webPreferences.additionalArguments`. */
export function daemonUrlFromArgv(argv: readonly string[]): string | null {
  const hit = argv.find((arg) => arg.startsWith(DAEMON_URL_FLAG));
  return hit ? hit.slice(DAEMON_URL_FLAG.length) : null;
}

// M2 adds `getDaemonToken()` here — a function, never a cached string, so a
// daemon restart's rotated token is picked up on the next call (R29).
contextBridge.exposeInMainWorld('larkAPI', {
  daemonUrl: daemonUrlFromArgv(process.argv),
} satisfies LarkApi);
