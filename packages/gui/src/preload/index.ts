import { contextBridge } from 'electron';
import { DAEMON_URL_FLAG, argvValue } from '../shared/argv.js';
import type { LarkApi } from '../shared/lark-api.js';

// T2 adds `getDaemonToken()` here — a function reading the token-path flag's
// file on every call, never a cached string, so a daemon restart's rotated
// token is picked up on the next call (R29).
contextBridge.exposeInMainWorld('larkAPI', {
  daemonUrl: argvValue(process.argv, DAEMON_URL_FLAG),
} satisfies LarkApi);
