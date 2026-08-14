import { readFileSync } from 'node:fs';
import { contextBridge, ipcRenderer } from 'electron';
import { DAEMON_TOKEN_PATH_FLAG, DAEMON_URL_FLAG, argvValue } from '../shared/argv.js';
import { IPC_CHANNELS } from '../shared/ipc.js';
import type { LarkApi, LegalDocument } from '../shared/lark-api.js';
import { GUI_VERSION } from '../shared/version.js';

const tokenPath = argvValue(process.argv, DAEMON_TOKEN_PATH_FLAG);

/**
 * Fresh read per call (R29) — contextBridge freezes plain values, so only a
 * function can track the daemon's token rotation. Unreadable (daemon not yet
 * started, file momentarily absent during rotation) reads as `null`, never an
 * exception across the bridge.
 */
function getDaemonToken(): string | null {
  if (tokenPath === null) return null;
  try {
    const token = readFileSync(tokenPath, 'utf8').trim();
    return token === '' ? null : token;
  } catch {
    return null;
  }
}

contextBridge.exposeInMainWorld('larkAPI', {
  daemonUrl: argvValue(process.argv, DAEMON_URL_FLAG),
  getDaemonToken,
  rendererPid: process.pid,
  guiVersion: GUI_VERSION,
  pickMp3: () => ipcRenderer.invoke(IPC_CHANNELS.pickMp3) as Promise<string[]>,
  openExternal: (url: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openExternal, url) as Promise<boolean>,
  pickJsonFile: () => ipcRenderer.invoke(IPC_CHANNELS.pickJsonFile) as Promise<string | null>,
  saveExportFile: (input: { default_name: string; content: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveExportFile, input) as Promise<boolean>,
  readLegal: (document: LegalDocument) =>
    ipcRenderer.invoke(IPC_CHANNELS.readLegal, document) as Promise<string | null>,
  openMigrationBackup: () =>
    ipcRenderer.invoke(IPC_CHANNELS.openMigrationBackup) as Promise<boolean>,
} satisfies LarkApi);
